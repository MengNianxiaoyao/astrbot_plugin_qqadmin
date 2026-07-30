import { createApi } from "./api.js";
import {
  collectFormData,
  renderSchemaFields,
} from "./form-renderer.js";
import {
  renderGroupCards,
  renderGroupDetailHeader,
} from "./group-view.js";

const bridge = window.AstrBotPluginPage;
const themeMediaQuery =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
const THEME_STORAGE_KEY = "qqadmin-page-theme-mode";
const DEFAULT_GROUP_ID = "__default__";
const COLLAPSED_GROUP_OBJECT_PATHS = new Set(["perms"]);
const FOLLOW_DEFAULT_KEY = "follow_default";

let api = null;
let bootstrapData = null;
let currentGroup = null;
let allGroups = [];
let detachContextHandler = null;
let detachSystemThemeHandler = null;
let themePreference = loadThemePreference();
let groupRoleSyncToken = 0;

const els = {
  groupForm: document.getElementById("groupForm"),
  groupList: document.getElementById("groupList"),
  groupSearchInput: document.getElementById("groupSearchInput"),
  currentGroupName: document.getElementById("currentGroupName"),
  groupListCount: document.getElementById("groupListCount"),
  toastLayer: document.getElementById("toastLayer"),
  toggleThemeBtn: document.getElementById("toggleThemeBtn"),
  refreshGroupsBtn: document.getElementById("refreshGroupsBtn"),
  saveGroupBtn: document.getElementById("saveGroupBtn"),
  resetGroupBtn: document.getElementById("resetGroupBtn"),
  globalListPanel: document.getElementById("globalListPanel"),
  globalListDisplay: document.getElementById("globalListDisplay"),
  globalListBatchInput: document.getElementById("globalListBatchInput"),
  overwriteGlobalListBtn: document.getElementById("overwriteGlobalListBtn"),
  appendGlobalListBtn: document.getElementById("appendGlobalListBtn"),
  groupActions: document.getElementById("groupActions"),
  groupListPanel: document.getElementById("groupListPanel"),
  workspaceGrid: document.querySelector(".workspace-grid"),
  viewTabs: document.querySelectorAll(".view-tab"),
  globalListTabs: document.querySelectorAll(".global-list-tab"),
};

let currentGlobalType = "allow";
let globalListData = { allow: [], block: [] };

function loadThemePreference() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "auto") {
      return stored;
    }
  } catch {}
  return "auto";
}

function saveThemePreference() {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
  } catch {}
}

function getThemeButtonLabel() {
  if (themePreference === "dark") {
    return "主题：深色";
  }
  if (themePreference === "light") {
    return "主题：浅色";
  }
  return "主题：自动";
}

function updateThemeButton() {
  if (els.toggleThemeBtn) {
    els.toggleThemeBtn.textContent = getThemeButtonLabel();
  }
}

function getBridgeThemeMode(context) {
  if (context?.theme === "dark" || context?.theme === "light") {
    return context.theme;
  }
  return null;
}

function getSystemThemeMode() {
  return themeMediaQuery?.matches ? "dark" : "light";
}

function resolveThemeMode(context) {
  if (themePreference === "dark" || themePreference === "light") {
    return themePreference;
  }

  const bridgeThemeMode = getBridgeThemeMode(context);
  if (bridgeThemeMode) {
    return bridgeThemeMode;
  }

  return getSystemThemeMode();
}

function applyThemeMode(themeMode) {
  const root = document.documentElement;
  root.dataset.theme = themeMode;
  root.style.colorScheme = themeMode;
}

function syncThemeFromContext(context) {
  applyThemeMode(resolveThemeMode(context));
  updateThemeButton();
}

function cycleThemePreference() {
  if (themePreference === "auto") {
    themePreference = "dark";
  } else if (themePreference === "dark") {
    themePreference = "light";
  } else {
    themePreference = "auto";
  }
  saveThemePreference();
  syncThemeFromContext(bridge?.getContext?.());
}

function bindSystemTheme() {
  if (!themeMediaQuery) {
    return;
  }

  const handleThemeChange = () => {
    if (themePreference === "auto") {
      applyThemeMode(resolveThemeMode(bridge?.getContext?.()));
    }
  };

  if (typeof themeMediaQuery.addEventListener === "function") {
    themeMediaQuery.addEventListener("change", handleThemeChange);
    detachSystemThemeHandler = () => {
      themeMediaQuery.removeEventListener("change", handleThemeChange);
    };
    return;
  }

  if (typeof themeMediaQuery.addListener === "function") {
    themeMediaQuery.addListener(handleThemeChange);
    detachSystemThemeHandler = () => {
      themeMediaQuery.removeListener(handleThemeChange);
    };
  }
}

function showToast(message, type = "success") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  els.toastLayer.appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

function getDefaultGroupConfigValues() {
  if (currentGroup?.group_id === DEFAULT_GROUP_ID) {
    return currentGroup.config || {};
  }
  const defaultGroup = bootstrapData?.groups?.find(
    (g) => g.group_id === DEFAULT_GROUP_ID
  );
  return defaultGroup?.config || {};
}

function buildGroupFormValues(groupPayload) {
  const defaultValues = getDefaultGroupConfigValues();
  const currentValues = groupPayload?.config || {};
  const followDefault = Boolean(currentValues[FOLLOW_DEFAULT_KEY]);
  const mergedValues = followDefault && !groupPayload?.is_default_group
    ? {
        ...defaultValues,
        [FOLLOW_DEFAULT_KEY]: true,
      }
    : currentValues;
  return mergedValues;
}

function isGroupFieldDisabled(path) {
  if (!currentGroup || currentGroup.is_default_group) {
    return false;
  }
  if (!currentGroup.config?.[FOLLOW_DEFAULT_KEY]) {
    return false;
  }
  return path !== FOLLOW_DEFAULT_KEY;
}

function updateGroupActionState() {
  const isDefaultGroup = Boolean(currentGroup?.is_default_group);
  const isFollowingDefault = Boolean(currentGroup?.config?.[FOLLOW_DEFAULT_KEY]);

  els.resetGroupBtn.disabled = isDefaultGroup || isFollowingDefault;
  els.resetGroupBtn.textContent = isDefaultGroup
    ? "默认群不支持重置"
    : isFollowingDefault
      ? "当前正在跟随默认配置"
      : "恢复当前项默认值";
  els.saveGroupBtn.textContent = isDefaultGroup
    ? "保存默认群模板"
    : "保存当前项配置";
}

function normalizeGroups(groups) {
  return Array.isArray(groups) ? groups : [];
}

function applyGroupList(groups) {
  allGroups = normalizeGroups(groups);
  bootstrapData.groups = allGroups;
  filterAndRenderGroups();
}

function scheduleGroupRoleSync(options = {}) {
  const requestToken = ++groupRoleSyncToken;
  syncGroupRoles(requestToken, options);
}

function filterGroups() {
  const keyword = String(els.groupSearchInput.value || "")
    .trim()
    .toLowerCase();
  if (!keyword) {
    return allGroups;
  }
  return allGroups.filter((group) => {
    const groupId = String(group.group_id || "").toLowerCase();
    const groupName = String(group.group_name || "").toLowerCase();
    return groupId.includes(keyword) || groupName.includes(keyword);
  });
}

function filterAndRenderGroups() {
  const groups = filterGroups();
  els.groupListCount.textContent = `${groups.length} 个群`;
  renderGroupCards({
    root: els.groupList,
    groups,
    currentGroupId: currentGroup?.group_id || "",
    onSelect: async (groupId) => {
      try {
        await switchGroup(groupId);
      } catch (error) {
        showToast(error.message, "error");
      }
    },
  });
}

function renderGroupForm(groupPayload) {
  currentGroup = groupPayload;

  renderGroupDetailHeader(els, groupPayload);
  renderSchemaFields(
    els.groupForm,
    bootstrapData.schema.group || {},
    buildGroupFormValues(groupPayload),
    {
      singleColumn: true,
      collapsedObjectPaths: COLLAPSED_GROUP_OBJECT_PATHS,
      isFieldDisabled: isGroupFieldDisabled,
    }
  );
  bindFollowDefaultToggle();
  updateGroupActionState();
  filterAndRenderGroups();
}

async function loadBootstrapData() {
  const data = await api.safeGet("settings/bootstrap");
  bootstrapData = data;
  applyGroupList(data.groups || []);
}

async function syncGroupRoles(requestToken, options = {}) {
  const { force = false } = options;
  try {
    const groups = await api.safePost("settings/groups/roles", {
      force: force ? "1" : "0",
    });
    if (requestToken !== groupRoleSyncToken) {
      return;
    }
    applyGroupList(groups || []);
  } catch (error) {
    if (requestToken === groupRoleSyncToken) {
      console.debug?.("Failed to sync group bot roles", error);
    }
  }
}

async function refreshGroups() {
  const groups = await api.safePost("settings/groups/refresh", {});
  applyGroupList(groups || []);
}

async function loadGroupConfig(groupId, force = false) {
  const target = String(groupId || currentGroup?.group_id || DEFAULT_GROUP_ID).trim();
  if (!target) {
    showToast("先从左侧选择一个群", "error");
    return;
  }

  const data = await api.safeGet("settings/group", {
    group_id: target,
    force: force ? "1" : "0",
  });
  renderGroupForm(data);
}

function bindFollowDefaultToggle() {
  const followDefaultInput = els.groupForm.querySelector(
    `[data-path="${FOLLOW_DEFAULT_KEY}"]`
  );
  if (!followDefaultInput) {
    return;
  }

  followDefaultInput.addEventListener("change", () => {
    if (!currentGroup?.config) {
      return;
    }
    currentGroup.config[FOLLOW_DEFAULT_KEY] = Boolean(followDefaultInput.checked);
    renderGroupForm(currentGroup);
  });
}

function getCurrentGroupFormPayload() {
  return collectFormData(els.groupForm);
}

async function persistGroupConfig(groupId, options = {}) {
  const {
    refreshList = true,
    rerenderCurrent = true,
    successMessage = "",
  } = options;
  const target = String(groupId || currentGroup?.group_id || "").trim();
  if (!target) {
    showToast("先加载群配置再保存", "error");
    return null;
  }
  const payload = getCurrentGroupFormPayload();
  const data = await api.safePost("settings/group", {
    group_id: target,
    config: payload,
  });
  if (rerenderCurrent) {
    renderGroupForm(data);
  }
  if (refreshList) {
    await refreshGroups();
  }
  if (successMessage) {
    showToast(successMessage);
  }
  return data;
}

async function saveCurrentGroupBeforeSwitch(nextGroupId) {
  const currentGroupId = String(currentGroup?.group_id || "").trim();
  const targetGroupId = String(nextGroupId || "").trim();
  if (!currentGroupId || !targetGroupId || currentGroupId === targetGroupId) {
    return;
  }
  if (!els.groupForm.querySelector("[data-path]")) {
    return;
  }

  await persistGroupConfig(currentGroupId, {
    refreshList: false,
    rerenderCurrent: false,
  });
}

async function switchGroup(groupId) {
  const target = String(groupId || "").trim();
  if (!target) {
    return;
  }

  await saveCurrentGroupBeforeSwitch(target);
  await loadGroupConfig(target);
}

async function saveGroupConfig() {
  const target = String(currentGroup?.group_id || "").trim();
  const data = await persistGroupConfig(target, {
    successMessage: `群 ${target} 配置已保存`,
  });
  return data;
}

async function resetGroupConfig() {
  const target = String(currentGroup?.group_id || "").trim();
  if (!target) {
    showToast("先加载群配置再重置", "error");
    return;
  }
  const data = await api.safePost("settings/group/reset", { group_id: target });
  renderGroupForm(data);
  await refreshGroups();
  showToast(`群 ${target} 已恢复默认群配置`);
}

function switchView(view) {
  const isGlobal = view === "global";

  els.workspaceGrid.classList.toggle("global-list-mode", isGlobal);
  els.globalListPanel.classList.toggle("is-hidden", !isGlobal);
  els.groupForm.style.display = isGlobal ? "none" : "";
  els.groupActions.style.display = isGlobal ? "none" : "";
  els.currentGroupName.textContent = isGlobal
    ? "全局配置"
    : currentGroup?.group_info?.group_name || "未选择群";

  els.viewTabs.forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });

  if (isGlobal) {
    loadGlobalLists();
  }
}

async function loadGlobalLists() {
  try {
    const data = await api.safeGet("settings/global-list");
    globalListData = data;
    renderGlobalList();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderGlobalList() {
  const items = globalListData[currentGlobalType] || [];
  const container = els.globalListDisplay;
  container.innerHTML = "";

  const countBar = document.createElement("div");
  countBar.className = "global-list-count";
  countBar.textContent = `共 ${items.length} 个`;
  container.appendChild(countBar);

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "global-list-empty";
    empty.textContent = "当前名单为空。";
    container.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "global-list-rows";

  items.forEach((uid, index) => {
    const row = document.createElement("div");
    row.className = "global-list-row";

    const label = document.createElement("span");
    label.className = "global-list-row-label";
    label.textContent = uid;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "global-list-row-del";
    del.textContent = "删除";
    del.addEventListener("click", async () => {
      const ok = await showConfirm(`确定删除 ${uid} 吗？`);
      if (!ok) return;
      globalListData[currentGlobalType] = items.filter((_, i) => i !== index);
      renderGlobalList();
    });

    row.appendChild(label);
    row.appendChild(del);
    list.appendChild(row);
  });

  container.appendChild(list);
}

function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve(false);
      }
    });

    const box = document.createElement("div");
    box.className = "confirm-box";

    const msg = document.createElement("p");
    msg.className = "confirm-message";
    msg.textContent = message;

    const actions = document.createElement("div");
    actions.className = "confirm-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "ghost-button";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", () => {
      overlay.remove();
      resolve(false);
    });

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "primary-button";
    confirmBtn.textContent = "确定";
    confirmBtn.addEventListener("click", () => {
      overlay.remove();
      resolve(true);
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    box.appendChild(msg);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

function getBatchItems() {
  const text = els.globalListBatchInput.value.trim();
  if (!text) return [];
  const items = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return [...new Set(items)];
}

function clearBatchInput() {
  els.globalListBatchInput.value = "";
}

async function overwriteGlobalList() {
  const items = getBatchItems();
  const ok = await showConfirm(`确定覆写全局${currentGlobalType === "allow" ? "白名单" : "黑名单"}吗？`);
  if (!ok) return;
  try {
    await api.safePost("settings/global-list", {
      type: currentGlobalType,
      items,
    });
    globalListData[currentGlobalType] = items;
    clearBatchInput();
    renderGlobalList();
    showToast(`全局${currentGlobalType === "allow" ? "白名单" : "黑名单"}已覆写`);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function appendGlobalList() {
  const batchItems = getBatchItems();
  if (!batchItems.length) {
    showToast("输入框为空", "error");
    return;
  }
  const existingItems = globalListData[currentGlobalType] || [];
  const existingSet = new Set(existingItems);
  const newItems = batchItems.filter((item) => !existingSet.has(item));
  if (!newItems.length) {
    showToast("所有数据均已存在，无需添加", "error");
    return;
  }
  const merged = [...existingItems, ...newItems];
  try {
    await api.safePost("settings/global-list", {
      type: currentGlobalType,
      items: merged,
    });
    globalListData[currentGlobalType] = merged;
    clearBatchInput();
    renderGlobalList();
    const skipped = batchItems.length - newItems.length;
    const msg = skipped > 0 ? `已添加 ${newItems.length} 个（${skipped} 个重复已跳过）` : `已添加 ${newItems.length} 个`;
    showToast(msg);
  } catch (error) {
    showToast(error.message, "error");
  }
}

function bindEvents() {
  els.toggleThemeBtn.addEventListener("click", () => {
    cycleThemePreference();
  });

  els.refreshGroupsBtn.addEventListener("click", async () => {
    try {
      await refreshGroups();
      scheduleGroupRoleSync({ force: true });
      if (currentGroup?.group_id) {
        await loadGroupConfig(currentGroup.group_id);
      }
      showToast("群列表已同步");
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  els.saveGroupBtn.addEventListener("click", async () => {
    try {
      await saveGroupConfig();
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  els.resetGroupBtn.addEventListener("click", async () => {
    try {
      if (currentGroup?.is_default_group) {
        showToast("默认群模板不支持重置", "error");
        return;
      }
      if (currentGroup?.config?.[FOLLOW_DEFAULT_KEY]) {
        showToast("当前群正在跟随默认配置，无需重置", "error");
        return;
      }
      await resetGroupConfig();
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  els.groupSearchInput.addEventListener("input", () => {
    filterAndRenderGroups();
  });

  els.viewTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      switchView(tab.dataset.view);
    });
  });

  els.globalListTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      els.globalListTabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", String(active));
      });
      currentGlobalType = tab.dataset.globalType;
      renderGlobalList();
    });
  });

  els.overwriteGlobalListBtn.addEventListener("click", async () => {
    try {
      await overwriteGlobalList();
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  els.appendGlobalListBtn.addEventListener("click", async () => {
    try {
      await appendGlobalList();
    } catch (error) {
      showToast(error.message, "error");
    }
  });
}

async function init() {
  bindSystemTheme();
  updateThemeButton();
  applyThemeMode(resolveThemeMode(null));

  if (!bridge) {
    return;
  }

  try {
    api = createApi(bridge);
  } catch (error) {
    return;
  }

  try {
    if (typeof bridge.ready === "function") {
      const context = await Promise.race([
        bridge.ready(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Bridge ready timeout")), 5000)
        ),
      ]);
      syncThemeFromContext(context);
    }

    if (typeof bridge.onContext === "function") {
      detachContextHandler = bridge.onContext((context) => {
        syncThemeFromContext(context);
      });
    } else {
      syncThemeFromContext(bridge.getContext?.());
    }

    bindEvents();
    await loadBootstrapData();
    scheduleGroupRoleSync();
    await loadGroupConfig(DEFAULT_GROUP_ID);
  } catch (error) {
    const message = error?.message || "页面初始化失败";
    showToast(message, "error");
  }
}

window.addEventListener("beforeunload", () => {
  detachContextHandler?.();
  detachSystemThemeHandler?.();
});

init();
