const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

/**
 * Metro for a Bun monorepo with a hoisted node_modules.
 *
 * Expo's defaults already watch the workspace root and resolve from both
 * node_modules folders, so the only thing added here is the singleton pin
 * below — overriding the rest is what expo-doctor warns against.
 *
 * The pin exists because the workspaces disagree on React. React Native 0.81
 * needs react 19.1.0 exactly, while the web app is on 19.2, which the hoisted
 * install puts at the root. Every library hoisted to the root (react-native
 * itself, react-query, heroui-native, expo-router) would then resolve the root
 * copy, and the bundle would hold two Reacts: "Invalid hook call" at best, a
 * renderer version mismatch at launch at worst. Resolving these few packages
 * from this app's own node_modules first guarantees one copy of each.
 */

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

const SINGLETONS = ["react", "react-dom"];
const localNodeModules = path.join(projectRoot, "node_modules");

const upstreamResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
	const root = moduleName.startsWith("@")
		? moduleName.split("/").slice(0, 2).join("/")
		: moduleName.split("/")[0];

	if (SINGLETONS.includes(root)) {
		return context.resolveRequest(
			{ ...context, originModulePath: path.join(localNodeModules, "index.js") },
			moduleName,
			platform,
		);
	}

	return upstreamResolveRequest
		? upstreamResolveRequest(context, moduleName, platform)
		: context.resolveRequest(context, moduleName, platform);
};

// The server and the web app are never imported by the app; watching them only
// costs file-watcher time and occasionally trips over .next build output.
config.resolver.blockList = [/apps\/web\/.*/, /apps\/server\/.*/];

module.exports = withUniwindConfig(config, {
	cssEntryFile: "./global.css",
	dtsFile: "./uniwind-types.d.ts",
});
