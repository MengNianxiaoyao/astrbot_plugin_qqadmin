const THEME_STORAGE_KEY = "qqadmin-page-theme-mode";

function loadPreference() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "auto") {
      return stored;
    }
  } catch {
    /* ignore */
  }
  return "auto";
}

function persistPreference(value) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
}

export function createThemeController({ getContext, onModeChange }) {
  const themeMediaQuery =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;

  let preference = loadPreference();
  let detachSystem = null;

  const bridgeMode = (context) =>
    context?.theme === "dark" || context?.theme === "light"
      ? context.theme
      : null;

  const systemMode = () => (themeMediaQuery?.matches ? "dark" : "light");

  function resolveMode(context) {
    if (preference === "dark" || preference === "light") {
      return preference;
    }
    return bridgeMode(context) || systemMode();
  }

  function apply(mode) {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
  }

  function sync(context) {
    apply(resolveMode(context));
  }

  function onSystemChange() {
    if (preference === "auto") {
      sync(getContext());
    }
  }

  function bind() {
    if (!themeMediaQuery) {
      return;
    }
    if (typeof themeMediaQuery.addEventListener === "function") {
      themeMediaQuery.addEventListener("change", onSystemChange);
      detachSystem = () =>
        themeMediaQuery.removeEventListener("change", onSystemChange);
    } else if (typeof themeMediaQuery.addListener === "function") {
      themeMediaQuery.addListener(onSystemChange);
      detachSystem = () => themeMediaQuery.removeListener(onSystemChange);
    }
  }

  function cycle() {
    preference =
      preference === "auto" ? "dark" :
      preference === "dark" ? "light" :
      "auto";
    persistPreference(preference);
    sync(getContext());
    onModeChange?.();
  }

  return {
    bind,
    sync,
    cyclePreference: cycle,
    detach() {
      detachSystem?.();
    },
    getButtonLabel() {
      return preference === "dark"
        ? "主题：深色"
        : preference === "light"
          ? "主题：浅色"
          : "主题：自动";
    },
  };
}