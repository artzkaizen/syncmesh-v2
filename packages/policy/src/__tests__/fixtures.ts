import type { CellValue, ColumnName, Row } from "@syncmesh/kernel";

import type { PolicyContext, PolicyGrant } from "../evaluate.js";

export const column = (name: string): ColumnName => {
  // SAFETY: test fixture; column naming rules live in the schema package
  return name as ColumnName;
};

export const row = (values: Readonly<Record<string, CellValue>>): Row =>
  new Map(Object.entries(values).map(([name, value]) => [column(name), value]));

export const LADDER = ["owner", "admin", "member", "viewer"] as const;

export const grant = (overrides: Partial<PolicyGrant> = {}): PolicyGrant => ({
  account: "acct_a",
  role: "member",
  claims: {
    member: "m_1",
    entities: ["e_root", "e_berlin"],
    permissions: { controls: ["read", "update"] },
  },
  ...overrides,
});

export const ctx = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  grant: grant(),
  roles: LADDER,
  ...overrides,
});

export const grantWithoutRole = (): PolicyGrant => {
  const { role: _role, ...rest } = grant();
  return rest;
};
