/**
 * #1733 parity check: the u2 login screens show the same social / enterprise
 * buttons as the legacy /u identifier page.
 */
import { describe, it, expect } from "vitest";
import type { Connection } from "@authhero/adapter-interfaces";
import { Strategy } from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";
import {
  getButtonConnections,
  isShownAsButton,
} from "../../../src/routes/universal-login/screens/social-connections";

const SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const FACEBOOK_IN_APP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0.0.0]";

function connection(
  name: string,
  strategy: string,
  extra: Partial<Connection> = {},
): Connection {
  return {
    id: name,
    name,
    strategy,
    options: {},
    ...extra,
  } as Connection;
}

describe("social button rules", () => {
  it("leaves out form connections and keeps client order", () => {
    const result = getButtonConnections(
      [
        connection("github", Strategy.GITHUB),
        connection("email", Strategy.EMAIL),
        connection(
          "Username-Password-Authentication",
          Strategy.USERNAME_PASSWORD,
        ),
        connection("apple", Strategy.APPLE),
      ],
      SAFARI,
    );
    expect(result.map((c) => c.name)).toEqual(["github", "apple"]);
  });

  it("hides show_as_button: false even without domain aliases", () => {
    expect(
      isShownAsButton(
        connection("github", Strategy.GITHUB, { show_as_button: false }),
        { embeddedBrowser: false },
      ),
    ).toBe(false);
  });

  it("hides HRD connections unless show_as_button is true", () => {
    const hrd = connection("acme", Strategy.OIDC, {
      options: { domain_aliases: ["acme.com"] },
    });
    expect(isShownAsButton(hrd, { embeddedBrowser: false })).toBe(false);
    expect(
      isShownAsButton(
        { ...hrd, show_as_button: true },
        { embeddedBrowser: false },
      ),
    ).toBe(true);
  });

  it("hides Google in in-app browsers only", () => {
    const connections = [
      connection("google-oauth2", Strategy.GOOGLE_OAUTH2),
      connection("github", Strategy.GITHUB),
    ];
    expect(
      getButtonConnections(connections, SAFARI).map((c) => c.name),
    ).toEqual(["google-oauth2", "github"]);
    expect(
      getButtonConnections(connections, FACEBOOK_IN_APP).map((c) => c.name),
    ).toEqual(["github"]);
  });

  it("keeps strategies without a built-in handler", () => {
    expect(
      isShownAsButton(connection("custom", "my-custom-strategy"), {
        embeddedBrowser: true,
      }),
    ).toBe(true);
  });
});

// show_as_button is covered by the rule tests above: the kysely adapter the
// test server uses can't store it on a connection.
describe("u2 login screens", () => {
  for (const identifierFirst of [true, false]) {
    const screenId = identifierFirst ? "identifier" : "login";
    it(`apply the rules on the ${screenId} screen`, async () => {
      const server = await getTestServer();
      const { env, u2App, oauthApp } = server;
      await env.data.connections.create("tenantId", {
        id: "github",
        name: "github",
        strategy: Strategy.GITHUB,
        options: {},
      });
      await env.data.connections.create("tenantId", {
        id: "acme",
        name: "acme",
        strategy: Strategy.OIDC,
        options: { domain_aliases: ["acme.com"] },
      });
      await env.data.clientConnections.updateByClient("tenantId", "clientId", [
        Strategy.USERNAME_PASSWORD,
        "github",
        "acme",
      ]);
      await env.data.promptSettings.set("tenantId", {
        identifier_first: identifierFirst,
      });

      const authorize = await oauthApp.request(
        `/authorize?${new URLSearchParams({
          client_id: "clientId",
          redirect_uri: "https://example.com/callback",
          state: "state",
          nonce: "nonce",
          scope: "openid",
          response_type: "code",
        })}`,
        { headers: { "tenant-id": "tenantId" } },
        env,
      );
      const state = new URL(
        `https://example.com${authorize.headers.get("location")}`,
      ).searchParams.get("state")!;

      const response = await u2App.request(
        `/screen/${screenId}?state=${encodeURIComponent(state)}`,
        { headers: { "tenant-id": "tenantId", "user-agent": SAFARI } },
        env,
      );
      expect(response.status).toBe(200);
      const { screen } = (await response.json()) as {
        screen: {
          components: Array<{
            type: string;
            config?: { providers?: string[] };
          }>;
        };
      };
      const social = screen.components.find((c) => c.type === "SOCIAL");
      expect(social?.config?.providers).toEqual(["github"]);
    });
  }
});
