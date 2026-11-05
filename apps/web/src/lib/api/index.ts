import { config } from "../config";
import { liveClient } from "./live/client";
import { mockClient } from "./mock/client";
import type { DefectClient } from "./types";

/** The one switch between fake data and the real backend: NEXT_PUBLIC_DATA_MODE. */
export const api: DefectClient = config.dataMode === "live" ? liveClient : mockClient;

export * from "./types";
export * from "./errors";
