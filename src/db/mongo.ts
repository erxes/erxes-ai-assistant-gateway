import mongoose from "mongoose";

import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

export const connectMongo = async () => {
  mongoose.connection.on("connected", () => {
    logger.info("MongoDB connected");
  });

  mongoose.connection.on("error", (error) => {
    logger.error("MongoDB connection error", { error: error.message });
  });

  mongoose.connection.on("disconnected", () => {
    logger.warn("MongoDB disconnected");
  });

  await mongoose.connect(env.MONGO_URL);
};

export const mongoHealth = () => {
  const readyState = mongoose.connection.readyState;
  const statusByState: Record<number, string> = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };

  return {
    readyState,
    status: statusByState[readyState] ?? "unknown",
  };
};

