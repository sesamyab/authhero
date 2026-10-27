import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const decoderPath = require.resolve("jsqr");
const grantType = "urn:ietf:params:oauth:grant-type:device_code";
interface DeviceGrant {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
  qr_code?: string;
}
async function issue(
  request: APIRequestContext,
  qr = false,
): Promise<DeviceGrant> {
  const response = await request.post("/oauth/device/code", {
    form: {
      client_id: "device-client",
      scope: "openid email offline_access",
      include_qr_code: String(qr),
    },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  return response.json();
}
async function poll(
  request: APIRequestContext,
  grant: DeviceGrant,
  clientId = "device-client",
) {
  return request.post("/oauth/token", {
    form: {
      grant_type: grantType,
      client_id: clientId,
      device_code: grant.device_code,
    },
  });
}
async function activate(page: Page, grant: DeviceGrant, complete = true) {
  await page.goto(
    complete ? grant.verification_uri_complete : grant.verification_uri,
  );
  await expect(page.locator("authhero-widget[data-ready]")).toBeVisible();
  const code = page.locator('input[name="user_code"]');
  if (complete) await expect(code).toHaveValue(grant.user_code);
  else await code.fill(grant.user_code.toLowerCase().replace("-", " "));
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator('input[name="username"]')).toBeVisible();
  await page.locator('input[name="username"]').fill("device@example.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator('input[name="password"]').fill("DeviceTest123!");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByText("Confirm your device", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(grant.user_code, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Test TV is requesting access to your account."),
  ).toBeVisible();
}
async function decide(page: Page, choice: "Approve" | "Deny") {
  await page.getByRole("radio", { name: choice, exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByText("Device request completed", { exact: true }),
  ).toBeVisible();
}

test.describe("RFC 8628 device authorization", () => {
  test("QR image decodes to the complete verification URL; browser approval yields single-use tokens", async ({
    page,
    request,
  }) => {
    const grant = await issue(request, true);
    expect(grant.interval).toBe(5);
    expect(grant.expires_in).toBe(600);
    expect(grant.qr_code).toMatch(/^data:image\/svg\+xml;base64,/);
    // Decode the actual image with an independent reader, rather than merely
    // checking its image type or comparing QR generator arguments.
    await page.goto("/");
    await page.addScriptTag({ path: decoderPath });
    const decoded = await page.evaluate(async (url) => {
      const img = new Image();
      img.src = url!;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(img, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      return (
        window as unknown as {
          jsQR: (
            data: Uint8ClampedArray,
            width: number,
            height: number,
          ) => { data: string } | null;
        }
      ).jsQR(pixels.data, pixels.width, pixels.height)?.data;
    }, grant.qr_code);
    expect(decoded).toBe(grant.verification_uri_complete);
    expect(decoded).not.toContain(grant.device_code);
    await activate(page, { ...grant, verification_uri_complete: decoded! });
    // The user still sees the matching code and requested scopes before consent.
    await expect(
      page.getByText("offline_access", { exact: true }),
    ).toBeVisible();
    await decide(page, "Approve");
    const response = await poll(request, grant);
    expect(response.status()).toBe(200);
    const tokens = await response.json();
    expect(tokens.id_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    const userinfo = await request.get("/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(userinfo.status()).toBe(200);
    expect((await userinfo.json()).sub).toBe("auth0|device-user");
    expect((await (await poll(request, grant)).json()).error).toBe(
      "invalid_grant",
    );
  });

  test("manual code entry is normalized; polling backs off and remains pending until explicit approval", async ({
    page,
    request,
  }) => {
    const grant = await issue(request);
    expect(grant.qr_code).toBeUndefined();
    expect((await (await poll(request, grant)).json()).error).toBe(
      "authorization_pending",
    );
    expect((await (await poll(request, grant)).json()).error).toBe("slow_down");
    await activate(page, grant, false);
    // GET navigation never approves the request.
    await page.reload();
    await expect(
      page.getByRole("radio", { name: "Approve", exact: true }),
    ).toBeVisible();
    await decide(page, "Approve");
    // A slowdown increases the original five-second interval to ten seconds.
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    expect((await poll(request, grant)).status()).toBe(200);
  });

  test("browser denial is terminal and is reported to the polling device", async ({
    page,
    request,
  }) => {
    const grant = await issue(request);
    await activate(page, grant);
    await decide(page, "Deny");
    await expect(
      page.getByText("The device request was denied. You can close this page."),
    ).toBeVisible();
    const response = await poll(request, grant);
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toBe("access_denied");
    expect((await (await poll(request, grant)).json()).error).toBe(
      "access_denied",
    );
  });

  test("another client cannot redeem the device code or alter the pending request", async ({
    request,
  }) => {
    const grant = await issue(request);
    expect(
      (await (await poll(request, grant, "other-device-client")).json()).error,
    ).toBe("invalid_grant");
    expect((await (await poll(request, grant)).json()).error).toBe(
      "authorization_pending",
    );
  });
});
