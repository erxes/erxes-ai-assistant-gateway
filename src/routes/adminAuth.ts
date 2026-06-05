import type { NextFunction, Request, Response } from "express";

import { env } from "../config/env.js";
import { unauthorized } from "../lib/errors.js";

export const requireAdminSecret = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const header = "x-erxes-gateway-admin-secret";
  const providedSecret =
    typeof req.headers?.[header] === "string" ? req.headers[header] : "";

  // TODO: Replace this shared secret with signed service auth and audit logs.
  if (!providedSecret || providedSecret !== env.ERXES_GATEWAY_ADMIN_SECRET) {
    next(unauthorized());
    return;
  }

  next();
};
