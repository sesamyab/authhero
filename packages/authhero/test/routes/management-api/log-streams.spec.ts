import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";

describe("log-streams", () => {
  describe("GET / - List", () => {
    it("returns empty array when no log streams exist", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      const response = await client["log-streams"].$get(
        { header: { "tenant-id": "tenantId" } },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    });

    it("returns array of log streams when they exist", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      // Create a log stream
      const created = await client["log-streams"].$post(
        {
          header: { "tenant-id": "tenantId" },
          json: {
            name: "test-stream",
            type: "http",
            status: "active",
            sink: {
              http_endpoint: "https://logs.example.com",
              http_content_type: "application/json",
              http_content_format: "JSONLINES",
            },
          },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(created.status).toBe(201);

      // List should now contain the created stream
      const list = await client["log-streams"].$get(
        { header: { "tenant-id": "tenantId" } },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(list.status).toBe(200);
      const streams = (await list.json()) as Array<{
        id: string;
        name: string;
      }>;
      expect(streams).toHaveLength(1);
      expect(streams[0].name).toBe("test-stream");
    });
  });

  describe("POST / - Create", () => {
    it("creates a log stream with valid data", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      const response = await client["log-streams"].$post(
        {
          header: { "tenant-id": "tenantId" },
          json: {
            name: "datadog-stream",
            type: "datadog",
            status: "active",
            sink: {
              api_key: "secret-key",
              region: "us",
            },
          },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(201);
      const stream = (await response.json()) as {
        id: string;
        name: string;
        type: string;
        status: string;
      };
      expect(stream.id).toBeTruthy();
      expect(stream.name).toBe("datadog-stream");
      expect(stream.type).toBe("datadog");
      expect(stream.status).toBe("active");
    });

    it("returns 400 when required field 'name' is missing", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      const response = await client["log-streams"].$post(
        {
          header: { "tenant-id": "tenantId" },
          json: {
            type: "http",
            status: "active",
            sink: {
              http_endpoint: "https://logs.example.com",
            },
          } as Record<string, unknown>,
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when required field 'type' is missing", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      const response = await client["log-streams"].$post(
        {
          header: { "tenant-id": "tenantId" },
          json: {
            name: "incomplete-stream",
            status: "active",
            sink: {
              http_endpoint: "https://logs.example.com",
            },
          } as Record<string, unknown>,
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when required field 'sink' is missing", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      const response = await client["log-streams"].$post(
        {
          header: { "tenant-id": "tenantId" },
          json: {
            name: "no-sink-stream",
            type: "http",
            status: "active",
          } as Record<string, unknown>,
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when 'type' is invalid", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      const response = await client["log-streams"].$post(
        {
          header: { "tenant-id": "tenantId" },
          json: {
            name: "invalid-type-stream",
            type: "invalid",
            sink: {
              endpoint: "https://logs.example.com",
            },
          } as Record<string, unknown>,
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(400);
    });
  });

  describe("GET /{id} - Get by ID", () => {
    it("returns a log stream by id", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      // Create a log stream
      const created = await client["log-streams"].$post(
        {
          header: { "tenant-id": "tenantId" },
          json: {
            name: "get-test-stream",
            type: "splunk",
            status: "active",
            sink: {
              hec_endpoint: "https://splunk.example.com",
              hec_token: "token123",
            },
          },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(created.status).toBe(201);
      const createdStream = (await created.json()) as { id: string };

      // Get the created stream
      const get = await client["log-streams"][":id"].$get(
        {
          header: { "tenant-id": "tenantId" },
          param: { id: createdStream.id },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(get.status).toBe(200);
      const stream = (await get.json()) as {
        id: string;
        name: string;
        type: string;
      };
      expect(stream.id).toBe(createdStream.id);
      expect(stream.name).toBe("get-test-stream");
      expect(stream.type).toBe("splunk");
    });

    it("returns 404 when log stream does not exist", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      const response = await client["log-streams"][":id"].$get(
        {
          header: { "tenant-id": "tenantId" },
          param: { id: "non-existent-id" },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(404);
    });
  });

  describe("PATCH /{id} - Update", () => {
    it("updates a log stream", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      // Create a log stream
      const created = await client["log-streams"].$post(
        {
          header: { "tenant-id": "tenantId" },
          json: {
            name: "update-test-stream",
            type: "eventbridge",
            status: "active",
            sink: {
              aws_account_id: "123456789",
              aws_region: "us-east-1",
            },
          },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(created.status).toBe(201);
      const createdStream = (await created.json()) as { id: string };

      // Update the stream
      const patch = await client["log-streams"][":id"].$patch(
        {
          header: { "tenant-id": "tenantId" },
          param: { id: createdStream.id },
          json: { status: "paused" },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(patch.status).toBe(200);
      const updated = (await patch.json()) as {
        id: string;
        status: string;
        name: string;
      };
      expect(updated.id).toBe(createdStream.id);
      expect(updated.status).toBe("paused");
      expect(updated.name).toBe("update-test-stream");
    });

    it("supports partial updates", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      // Create a log stream with multiple fields
      const created = await client["log-streams"].$post(
        {
          header: { "tenant-id": "tenantId" },
          json: {
            name: "partial-update-stream",
            type: "sumo",
            status: "active",
            isPriority: false,
            sink: {
              collector_endpoint: "https://sumo.example.com",
            },
          },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(created.status).toBe(201);
      const createdStream = (await created.json()) as {
        id: string;
        isPriority: boolean;
      };

      // Update only the isPriority field
      const patch = await client["log-streams"][":id"].$patch(
        {
          header: { "tenant-id": "tenantId" },
          param: { id: createdStream.id },
          json: { isPriority: true },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(patch.status).toBe(200);
      const updated = (await patch.json()) as {
        isPriority: boolean;
        name: string;
        type: string;
      };
      expect(updated.isPriority).toBe(true);
      expect(updated.name).toBe("partial-update-stream");
      expect(updated.type).toBe("sumo");
    });

    it("returns 404 when log stream does not exist", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      const response = await client["log-streams"][":id"].$patch(
        {
          header: { "tenant-id": "tenantId" },
          param: { id: "non-existent-id" },
          json: { status: "paused" },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /{id} - Delete", () => {
    it("deletes a log stream", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      // Create a log stream
      const created = await client["log-streams"].$post(
        {
          header: { "tenant-id": "tenantId" },
          json: {
            name: "delete-test-stream",
            type: "http",
            status: "active",
            sink: {
              http_endpoint: "https://logs.example.com",
              http_content_type: "application/json",
            },
          },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(created.status).toBe(201);
      const createdStream = (await created.json()) as { id: string };

      // Delete the stream
      const del = await client["log-streams"][":id"].$delete(
        {
          header: { "tenant-id": "tenantId" },
          param: { id: createdStream.id },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(del.status).toBe(204);
    });

    it("verifies log stream is gone after deletion", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      // Create a log stream
      const created = await client["log-streams"].$post(
        {
          header: { "tenant-id": "tenantId" },
          json: {
            name: "verify-delete-stream",
            type: "eventgrid",
            status: "active",
            sink: {
              azure_event_grid_endpoint: "https://azure.example.com",
            },
          },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(created.status).toBe(201);
      const createdStream = (await created.json()) as { id: string };

      // Delete the stream
      const del = await client["log-streams"][":id"].$delete(
        {
          header: { "tenant-id": "tenantId" },
          param: { id: createdStream.id },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(del.status).toBe(204);

      // Verify it's gone
      const get = await client["log-streams"][":id"].$get(
        {
          header: { "tenant-id": "tenantId" },
          param: { id: createdStream.id },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(get.status).toBe(404);
    });

    it("returns 404 when log stream does not exist", async () => {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();

      const response = await client["log-streams"][":id"].$delete(
        {
          header: { "tenant-id": "tenantId" },
          param: { id: "non-existent-id" },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(404);
    });
  });

  describe("firehose type", () => {
    const SECRET = "super-secret-aws-key";
    const SINK = {
      aws_region: "eu-north-1",
      delivery_stream_name: "authhero-logs",
      aws_access_key_id: "AKIDEXAMPLE",
      aws_secret_access_key: SECRET,
    };

    async function setup() {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();
      const headers = { headers: { authorization: `Bearer ${token}` } };
      return { client, env, headers };
    }

    async function createFirehose(
      ctx: Awaited<ReturnType<typeof setup>>,
      sink: Record<string, unknown> = SINK,
    ) {
      return ctx.client["log-streams"].$post(
        {
          header: { "tenant-id": "tenantId" },
          json: { name: "firehose", type: "firehose", status: "active", sink },
        },
        ctx.headers,
      );
    }

    it("stores the secret but never returns it", async () => {
      const ctx = await setup();

      const created = await createFirehose(ctx);
      expect(created.status).toBe(201);
      const body = (await created.json()) as {
        id: string;
        sink: Record<string, unknown>;
      };
      expect(body.sink).toEqual({
        aws_region: "eu-north-1",
        delivery_stream_name: "authhero-logs",
        aws_access_key_id: "AKIDEXAMPLE",
      });

      const fetched = await ctx.client["log-streams"][":id"].$get(
        { param: { id: body.id }, header: { "tenant-id": "tenantId" } },
        ctx.headers,
      );
      const list = await ctx.client["log-streams"].$get(
        { header: { "tenant-id": "tenantId" } },
        ctx.headers,
      );
      expect(JSON.stringify(await fetched.json())).not.toContain(SECRET);
      expect(JSON.stringify(await list.json())).not.toContain(SECRET);

      const stored = await ctx.env.data.logStreams.get("tenantId", body.id);
      expect(stored?.sink.aws_secret_access_key).toBe(SECRET);
    });

    it("returns 400 for an unusable firehose sink", async () => {
      const ctx = await setup();

      const response = await createFirehose(ctx, {
        ...SINK,
        aws_secret_access_key: "",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        errorCode: "invalid_body",
        message: expect.stringContaining("secret access key are required"),
      });
    });

    it("keeps the stored secret when a sink update omits it", async () => {
      const ctx = await setup();
      const { id } = (await (await createFirehose(ctx)).json()) as {
        id: string;
      };

      const { aws_secret_access_key: _omitted, ...sinkWithoutSecret } = SINK;
      const patched = await ctx.client["log-streams"][":id"].$patch(
        {
          param: { id },
          header: { "tenant-id": "tenantId" },
          json: {
            sink: { ...sinkWithoutSecret, delivery_stream_name: "renamed" },
          },
        },
        ctx.headers,
      );

      expect(patched.status).toBe(200);
      const stored = await ctx.env.data.logStreams.get("tenantId", id);
      expect(stored?.sink.delivery_stream_name).toBe("renamed");
      expect(stored?.sink.aws_secret_access_key).toBe(SECRET);
    });

    it("replaces the secret when an update supplies a new one", async () => {
      const ctx = await setup();
      const { id } = (await (await createFirehose(ctx)).json()) as {
        id: string;
      };

      await ctx.client["log-streams"][":id"].$patch(
        {
          param: { id },
          header: { "tenant-id": "tenantId" },
          json: { sink: { ...SINK, aws_secret_access_key: "rotated" } },
        },
        ctx.headers,
      );

      const stored = await ctx.env.data.logStreams.get("tenantId", id);
      expect(stored?.sink.aws_secret_access_key).toBe("rotated");
    });

    it("returns 400 when an update would leave the sink unusable", async () => {
      const ctx = await setup();
      const { id } = (await (await createFirehose(ctx)).json()) as {
        id: string;
      };

      const patched = await ctx.client["log-streams"][":id"].$patch(
        {
          param: { id },
          header: { "tenant-id": "tenantId" },
          json: { sink: { ...SINK, aws_region: "evil.example.com/x" } },
        },
        ctx.headers,
      );

      expect(patched.status).toBe(400);
    });
  });

  describe("http_authorization is write-only", () => {
    const AUTH = "Bearer super-secret-token";
    const SINK = {
      http_endpoint: "https://logs.example.com",
      http_content_type: "application/json",
      http_content_format: "JSONLINES",
      http_authorization: AUTH,
    };

    async function setup() {
      const { managementApp, env } = await getTestServer();
      const client = testClient(managementApp, env);
      const token = await getAdminToken();
      const headers = { headers: { authorization: `Bearer ${token}` } };
      const created = await client["log-streams"].$post(
        {
          header: { "tenant-id": "tenantId" },
          json: { name: "loki", type: "http", status: "active", sink: SINK },
        },
        headers,
      );
      expect(created.status).toBe(201);
      const body = (await created.json()) as {
        id: string;
        sink: Record<string, unknown>;
      };
      return { client, env, headers, id: body.id, createdSink: body.sink };
    }

    async function patchSink(
      ctx: Awaited<ReturnType<typeof setup>>,
      sink: Record<string, unknown>,
      type?: "http" | "firehose",
    ) {
      return ctx.client["log-streams"][":id"].$patch(
        {
          param: { id: ctx.id },
          header: { "tenant-id": "tenantId" },
          json: { sink, ...(type ? { type } : {}) },
        },
        ctx.headers,
      );
    }

    async function storedSink(ctx: Awaited<ReturnType<typeof setup>>) {
      const stored = await ctx.env.data.logStreams.get("tenantId", ctx.id);
      return stored?.sink;
    }

    it("stores the header but never returns it", async () => {
      const ctx = await setup();

      expect(ctx.createdSink).not.toHaveProperty("http_authorization");
      expect(ctx.createdSink.http_endpoint).toBe("https://logs.example.com");

      const fetched = await ctx.client["log-streams"][":id"].$get(
        { param: { id: ctx.id }, header: { "tenant-id": "tenantId" } },
        ctx.headers,
      );
      const list = await ctx.client["log-streams"].$get(
        { header: { "tenant-id": "tenantId" } },
        ctx.headers,
      );
      const patched = await patchSink(ctx, {
        ...SINK,
        http_endpoint: "https://x.test",
      });
      for (const response of [fetched, list, patched]) {
        expect(JSON.stringify(await response.json())).not.toContain(AUTH);
      }

      expect((await storedSink(ctx))?.http_authorization).toBe(AUTH);
    });

    it("also hides the camelCase httpAuthorization Auth0 clients send", async () => {
      const ctx = await setup();
      await patchSink(ctx, {
        httpEndpoint: "https://logs.example.com",
        httpAuthorization: "Bearer camel-secret",
      });

      const fetched = await ctx.client["log-streams"][":id"].$get(
        { param: { id: ctx.id }, header: { "tenant-id": "tenantId" } },
        ctx.headers,
      );
      expect(JSON.stringify(await fetched.json())).not.toContain(
        "camel-secret",
      );
    });

    it("keeps the stored header when a sink update omits it or sends it blank", async () => {
      const ctx = await setup();
      const { http_authorization: _omitted, ...withoutAuth } = SINK;

      await patchSink(ctx, {
        ...withoutAuth,
        http_content_format: "JSONARRAY",
      });
      expect(await storedSink(ctx)).toMatchObject({
        http_content_format: "JSONARRAY",
        http_authorization: AUTH,
      });

      await patchSink(ctx, { ...SINK, http_authorization: "" });
      expect((await storedSink(ctx))?.http_authorization).toBe(AUTH);
    });

    it("replaces the header when an update supplies a new one", async () => {
      const ctx = await setup();

      await patchSink(ctx, { ...SINK, http_authorization: "Bearer rotated" });

      expect((await storedSink(ctx))?.http_authorization).toBe(
        "Bearer rotated",
      );
    });

    it("removes the header when an update sends null", async () => {
      const ctx = await setup();

      const response = await patchSink(ctx, {
        ...SINK,
        http_authorization: null,
      });

      expect(response.status).toBe(200);
      expect(await storedSink(ctx)).not.toHaveProperty("http_authorization");
    });

    it("does not carry the header into a sink of a different type", async () => {
      const ctx = await setup();

      const response = await patchSink(
        ctx,
        {
          aws_region: "eu-north-1",
          delivery_stream_name: "authhero-logs",
          aws_access_key_id: "AKIDEXAMPLE",
          aws_secret_access_key: "secret",
        },
        "firehose",
      );

      expect(response.status).toBe(200);
      expect(await storedSink(ctx)).not.toHaveProperty("http_authorization");
    });
  });

  it("creates, gets, lists, updates, and deletes a log stream - full integration", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();

    // Create
    const create = await client["log-streams"].$post(
      {
        header: { "tenant-id": "tenantId" },
        json: {
          name: "loki",
          type: "http",
          status: "active",
          sink: {
            http_endpoint: "https://logs.example.com",
            http_content_type: "application/json",
            http_content_format: "JSONLINES",
            http_authorization: "Bearer x",
          },
        },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string; name: string };
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("loki");

    // Get
    const get = await client["log-streams"][":id"].$get(
      {
        header: { "tenant-id": "tenantId" },
        param: { id: created.id },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(get.status).toBe(200);
    expect((await get.json()).name).toBe("loki");

    // List
    const list = await client["log-streams"].$get(
      { header: { "tenant-id": "tenantId" } },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toHaveLength(1);

    // Update
    const patch = await client["log-streams"][":id"].$patch(
      {
        header: { "tenant-id": "tenantId" },
        param: { id: created.id },
        json: { status: "paused" },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(patch.status).toBe(200);
    expect((await patch.json()).status).toBe("paused");

    // Delete
    const del = await client["log-streams"][":id"].$delete(
      {
        header: { "tenant-id": "tenantId" },
        param: { id: created.id },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(del.status).toBe(204);

    const afterDelete = await client["log-streams"].$get(
      { header: { "tenant-id": "tenantId" } },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(await afterDelete.json()).toEqual([]);
  });
});
