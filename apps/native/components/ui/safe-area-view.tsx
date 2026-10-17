import { SafeAreaView as BaseSafeAreaView } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";

/**
 * `SafeAreaView` from react-native-safe-area-context, taught `className`.
 *
 * Uniwind only maps `className` to `style` on React Native's own components.
 * This one is a third-party native view, so without the wrapper `flex-1` and
 * `bg-background` would type-check (it shares `ViewProps`) and then silently do
 * nothing — a screen collapsed to zero height on some layouts.
 *
 * The context version rather than React Native's: it pads for the status bar
 * and gesture bar on Android edge-to-edge too, not only on iOS.
 */
export const SafeAreaView = withUniwind(BaseSafeAreaView);
