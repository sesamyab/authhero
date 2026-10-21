import { RuleTester } from "eslint";
import { noDirectStateData } from "./state-data.mjs";

new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
}).run("no-direct-state-data", noDirectStateData, {
  valid: [
    "const data = session.state_data;",
    "const { state_data } = session;",
    "const next = { ...session, state: 'pending' };",
    "data.loginSessions.update(tenant, id, { authParams: session.authParams });",
    "data.loginSessions.update(tenant, id, { ...(flag ? { state: 'pending' } : {}) });",
    "updateLoginSessionData(sessions, tenant, id, event);",
  ],
  invalid: [
    "const payload = { state_data: '{}' };",
    "const payload = { 'state_data': '{}' };",
    "const payload = { ['state_data']: '{}' };",
    "const payload = { [`state_data`]: '{}' };",
    "const payload = { state_data };",
    "session.state_data = '{}';",
    "session['state_data'] = '{}';",
    "session[`state_data`] = '{}';",
    "delete session.state_data;",
    "session.state_data++;",
    "({ value: session.state_data } = payload);",
    "[session.state_data] = payload;",
    "Object.assign(session, { state_data: '{}' });",
    "Object.defineProperty(session, 'state_data', { value: '{}' });",
    "Reflect.set(session, 'state_data', '{}');",
    "Reflect.deleteProperty(session, 'state_data');",
  ]
    .map((code) => ({ code, errors: [{ messageId: "direct" }] }))
    .concat(
      [
        "data.loginSessions.update(tenant, id, session);",
        "data.loginSessions.update(tenant, id, { ...session });",
        "data.loginSessions.create(tenant, payload);",
        "loginSessions.update(tenant, id, payload);",
        "data.loginSessions?.update(tenant, id, payload);",
        "data.loginSessions.update?.(tenant, id, payload);",
        "data['loginSessions']['update'](tenant, id, payload);",
        "const { loginSessions: sessions } = data; sessions.update(tenant, id, payload);",
        "const sessions = data.loginSessions; sessions.create(tenant, payload);",
        "const { loginSessions: sessions = fallback } = data; sessions.update(tenant, id, payload);",
      ].map((code) => ({ code, errors: [{ messageId: "opaque" }] })),
    ),
});
