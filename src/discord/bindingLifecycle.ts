import { DiscordAssistantBinding } from "../models/DiscordAssistantBinding.js";
import { DiscordInstallation } from "../models/DiscordInstallation.js";

// Bindings freeze the runtime URL at connect time, so lifecycle events that
// move or destroy a runtime (assistant transfer, namespace delete) must find
// bindings BY URL — tenantId/assistantId are exactly the fields that went
// stale. See the 2026-08 audit: a transferred assistant kept chatting through
// its old-tenant binding, and deleted namespaces left enabled ghost bindings
// that dead-ended customer messages.

export const normalizeRuntimeUrl = (url: string) =>
  url.trim().replace(/\/+$/, "");

// Bindings were written by different erxes versions; match both the bare and
// trailing-slash spellings of the same runtime.
export const runtimeUrlVariants = (url: string) => {
  const base = normalizeRuntimeUrl(url);

  return base ? [base, `${base}/`] : [];
};

export type RehomeTarget = {
  tenantId: string;
  assistantId: string;
  assistantName?: string;
};

type GuildRef = { discordGuildId: string };
type InstallationRef = { discordGuildId: string; status: string };

// Pure planning step: a re-homed binding is only manageable from the target
// tenant's UI if that tenant has a connected installation for the guild.
// Returns the guilds that still need one.
export const guildsNeedingInstallation = (
  bindings: GuildRef[],
  targetTenantInstallations: InstallationRef[],
): string[] => {
  const covered = new Set(
    targetTenantInstallations
      .filter((installation) => installation.status === "connected")
      .map((installation) => installation.discordGuildId),
  );

  return [...new Set(bindings.map((binding) => binding.discordGuildId))].filter(
    (guildId) => !covered.has(guildId),
  );
};

export type RehomeResult = {
  matched: number;
  rehomed: number;
  installationsCloned: number;
};

export const rehomeBindingsForRuntime = async (
  openclawUrl: string,
  target: RehomeTarget,
): Promise<RehomeResult> => {
  const urls = runtimeUrlVariants(openclawUrl);

  if (!urls.length) {
    return { matched: 0, rehomed: 0, installationsCloned: 0 };
  }

  const bindings = await DiscordAssistantBinding.find({
    openclawUrl: { $in: urls },
  }).lean();

  if (!bindings.length) {
    return { matched: 0, rehomed: 0, installationsCloned: 0 };
  }

  const targetInstallations = await DiscordInstallation.find({
    tenantId: target.tenantId,
    status: "connected",
  }).lean();

  let installationsCloned = 0;

  for (const guildId of guildsNeedingInstallation(
    bindings,
    targetInstallations,
  )) {
    // Clone the guild's live installation for the target tenant instead of
    // moving it: the source tenant may still have other assistants bound in
    // the same guild.
    const source = await DiscordInstallation.findOne({
      discordGuildId: guildId,
      status: "connected",
    })
      .sort({ updatedAt: -1 })
      .lean();

    if (!source) {
      continue;
    }

    try {
      await DiscordInstallation.create({
        tenantId: target.tenantId,
        assistantId: target.assistantId,
        discordGuildId: guildId,
        discordGuildName: source.discordGuildName,
        installedByDiscordUserId: source.installedByDiscordUserId,
        installedByErxesUserId: source.installedByErxesUserId,
        status: "connected",
        scopes: source.scopes,
        permissions: source.permissions,
      });
      installationsCloned += 1;
    } catch (error) {
      // The partial unique index on (tenantId, guildId, connected) makes a
      // concurrent double-rehome collapse to one row; ignore the duplicate.
      if ((error as { code?: number }).code !== 11000) {
        throw error;
      }
    }
  }

  const updated = await DiscordAssistantBinding.updateMany(
    { openclawUrl: { $in: urls } },
    {
      $set: {
        tenantId: target.tenantId,
        assistantId: target.assistantId,
        ...(target.assistantName
          ? { assistantName: target.assistantName }
          : {}),
      },
    },
  );

  return {
    matched: bindings.length,
    rehomed: updated.modifiedCount,
    installationsCloned,
  };
};

export const disableBindingsForRuntime = async (
  openclawUrl: string,
): Promise<{ disabled: number }> => {
  const urls = runtimeUrlVariants(openclawUrl);

  if (!urls.length) {
    return { disabled: 0 };
  }

  const updated = await DiscordAssistantBinding.updateMany(
    { openclawUrl: { $in: urls }, enabled: true },
    { $set: { enabled: false } },
  );

  return { disabled: updated.modifiedCount };
};
