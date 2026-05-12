import { Strategy } from "../../src/strategies";

export const mockStrategy: Strategy = {
  getRedirect: async (_ctx, _connection, loginHint?: string) => {
    const redirectUrl = new URL("https://example.com/authorize");
    if (loginHint) {
      redirectUrl.searchParams.set("login_hint", loginHint);
    }
    return {
      redirectUrl: redirectUrl.href,
      code: "code",
    };
  },
  validateAuthorizationCodeAndGetUser: async (
    _ctx,
    _connection,
    code: string,
  ) => {
    // This is a way to provide different mock responses
    switch (code) {
      case "foo@example.com":
        return {
          sub: "foo",
          email: "foo@example.com",
        };
      case "vipps-user@example.com":
        return {
          sub: "vipps-456",
          email: "vipps-user@example.com",
          email_verified: true,
          given_name: "Test",
          family_name: "User",
          name: "Test User",
          phone_number: "+4712345678",
          phone_number_verified: true,
          picture: "https://example.com/avatar.jpg",
          nickname: "testuser",
        };
      case "vipps-user-updated@example.com":
        return {
          sub: "vipps-456",
          email: "vipps-user@example.com",
          email_verified: true,
          given_name: "Updated",
          family_name: "Name",
          name: "Updated Name",
          phone_number: "+4799999999",
          phone_number_verified: true,
          picture: "https://example.com/new-avatar.jpg",
          nickname: "updateduser",
        };
      default:
        return {
          sub: "123",
          email: "hello@example.com",
        };
    }
  },
};
