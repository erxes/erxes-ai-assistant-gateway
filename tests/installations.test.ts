import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertInstallationListScope,
  buildInstallationListQuery,
} from "../src/routes/adminInstallations.js";

test("one user installation is reusable by their assistants and runtime kinds", () => {
  assert.deepEqual(
    buildInstallationListQuery({
      tenantId: "tenant-1",
      installedByErxesUserId: "user-1",
      assistantId: "hermes-1",
      runtimeKind: "hermes",
      status: "connected",
    }),
    {
      tenantId: "tenant-1",
      installedByErxesUserId: "user-1",
      status: "connected",
    },
  );

  assert.deepEqual(
    buildInstallationListQuery({
      tenantId: "tenant-1",
      installedByErxesUserId: "user-1",
      assistantId: "openclaw-1",
      runtimeKind: "openclaw",
      status: "connected",
    }),
    {
      tenantId: "tenant-1",
      installedByErxesUserId: "user-1",
      status: "connected",
    },
  );
});

test("installation listing scopes by tenant and current erxes user", () => {
  assert.deepEqual(
    buildInstallationListQuery({
      tenantId: "tenant-2",
      installedByErxesUserId: "user-2",
      assistantId: "assistant-from-another-binding",
    }),
    { tenantId: "tenant-2", installedByErxesUserId: "user-2" },
  );
});

test("installation listing ignores malformed ownership filters", () => {
  assert.deepEqual(
    buildInstallationListQuery({
      tenantId: "tenant-1",
      installedByErxesUserId: { $ne: "user-1" },
      status: "connected",
    }),
    { tenantId: "tenant-1", status: "connected" },
  );
});

test("installation listing fails closed without tenant and user ownership", () => {
  assert.throws(
    () => assertInstallationListScope({ tenantId: "tenant-1" }),
    /tenantId and installedByErxesUserId are required/,
  );
  assert.throws(
    () => assertInstallationListScope({ installedByErxesUserId: "user-1" }),
    /tenantId and installedByErxesUserId are required/,
  );
  assert.doesNotThrow(() =>
    assertInstallationListScope({
      tenantId: "tenant-1",
      installedByErxesUserId: "user-1",
    }),
  );
});
