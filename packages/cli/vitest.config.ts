import { defineConfig, mergeConfig } from "vitest/config";
import shared from "@protoloom/config/vitest.shared";
export default mergeConfig(shared, defineConfig({}));
