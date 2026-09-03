import assert from "node:assert/strict";
import { test } from "node:test";

import { buildInstallationListQuery } from "../src/routes/adminInstallations.js";

test("one tenant installation is reusable by every assistant and runtime kind", () => {
  assert.deepEqual(
    buildInstallationListQuery({
      tenantId: "tenant-1",
      assistantId: "hermes-1",
      runtimeKind: "hermes",
      status: "connected",
    }),
    {
      tenantId: "tenant-1",
      status: "connected",
    },
  );

  assert.deepEqual(
    buildInstallationListQuery({
      tenantId: "tenant-1",
      assistantId: "openclaw-1",
      runtimeKind: "openclaw",
      status: "connected",
    }),
    {
      tenantId: "tenant-1",
      status: "connected",
    },
  );
});

test("installation listing still scopes by tenant when assistantId is supplied", () => {
  assert.deepEqual(
    buildInstallationListQuery({
      tenantId: "tenant-2",
      assistantId: "assistant-from-another-binding",
    }),
    { tenantId: "tenant-2" },
  );
});
