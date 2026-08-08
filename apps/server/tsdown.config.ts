import { defineConfig } from "tsdown";

export default defineConfig({
	// Both entrypoints. The jobs runner ships in the same image as the server —
	// it needs the same schema, the same env validation and the same database
	// client, and a second image would be a second thing to keep in step.
	entry: ["./src/index.ts", "./src/jobs/run.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
	noExternal: [/@greetings\/.*/],
});
