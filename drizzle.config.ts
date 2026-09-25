import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./ts/db/schema.ts",
  out: "./drizzle",
});
