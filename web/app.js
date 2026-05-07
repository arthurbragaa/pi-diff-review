const reviewData = JSON.parse(document.getElementById("diff-review-data").textContent || "{}");

const state = {
  activeFileId: null,
  currentScope: reviewData.files.some((file) => file.inGitDiff)
    ? "git-diff"
    : reviewData.files.some((file) => file.inLastCommit)
      ? "last-commit"
      : "all-files",
  selectedBranch: null,
  comments: [],
  overallComment: "",
  hideUnchanged: true,
  wrapLines: true,
  collapsedDirs: {},
  reviewedFiles: {},
  scrollPositions: {},
  sidebarCollapsed: false,
  showUnreviewedOnly: true,
  fileFilter: "",
  fileContents: {},
  fileErrors: {},
  pendingRequestIds: {},
  explanation: {
    status: "idle",
    requestId: null,
    title: "AI assistant",
    markdown: "",
    error: "",
    source: null,
    messages: [],
  },
  aiPanelWidth: 360,
};

const sidebarEl = document.getElementById("sidebar");
const sidebarTitleEl = document.getElementById("sidebar-title");
const sidebarSearchInputEl = document.getElementById("sidebar-search-input");
const toggleSidebarButton = document.getElementById("toggle-sidebar-button");
const branchComparisonSelect = document.getElementById("branch-comparison-select");
const scopeBranchButton = document.getElementById("scope-branch-button");
const scopeDiffButton = document.getElementById("scope-diff-button");
const scopeLastCommitButton = document.getElementById("scope-last-commit-button");
const scopeAllButton = document.getElementById("scope-all-button");
const filterUnreviewedButton = document.getElementById("filter-unreviewed-button");
const windowTitleEl = document.getElementById("window-title");
const repoRootEl = document.getElementById("repo-root");
const fileTreeEl = document.getElementById("file-tree");
const summaryEl = document.getElementById("summary");
const currentFileLabelEl = document.getElementById("current-file-label");
const modeHintEl = document.getElementById("mode-hint");
const fileCommentsContainer = document.getElementById("file-comments-container");
const editorContainerEl = document.getElementById("editor-container");
const submitButton = document.getElementById("submit-button");
const cancelButton = document.getElementById("cancel-button");
const overallCommentButton = document.getElementById("overall-comment-button");
const fileCommentButton = document.getElementById("file-comment-button");
const toggleReviewedButton = document.getElementById("toggle-reviewed-button");
const toggleUnchangedButton = document.getElementById("toggle-unchanged-button");
const toggleWrapButton = document.getElementById("toggle-wrap-button");
const aiPanelEl = document.getElementById("ai-panel");
const aiPanelResizerEl = document.getElementById("ai-panel-resizer");
const explanationTitleEl = document.getElementById("explanation-title");
const explanationStatusEl = document.getElementById("explanation-status");
const explanationOutputEl = document.getElementById("explanation-output");
const explainFileButton = document.getElementById("explain-file-button");
const explainSelectionButton = document.getElementById("explain-selection-button");
const explanationAddCommentButton = document.getElementById("explanation-add-comment-button");
const explanationAddOverallButton = document.getElementById("explanation-add-overall-button");
const aiChatInputEl = document.getElementById("ai-chat-input");
const aiChatButton = document.getElementById("ai-chat-button");

repoRootEl.textContent = reviewData.repoRoot || "";
windowTitleEl.textContent = "Review";

function sendClientLog(level, message, details) {
  try {
    if (window.glimpse?.send) {
      window.glimpse.send({ type: "client-log", level, message, details });
    }
  } catch {}
}

window.addEventListener("error", (event) => {
  sendClientLog("error", "window error", {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    error: event.error?.stack || String(event.error || ""),
  });
});

window.addEventListener("unhandledrejection", (event) => {
  sendClientLog("error", "unhandled rejection", {
    reason: event.reason?.stack || String(event.reason || ""),
  });
});

let monacoApi = null;
let diffEditor = null;
let originalModel = null;
let modifiedModel = null;
let originalDecorations = [];
let modifiedDecorations = [];
let activeViewZones = [];
let editorResizeObserver = null;
let requestSequence = 0;

const reviewFileById = new Map(reviewData.files.map((file) => [file.id, file]));
let persistedReviewedFiles = reviewData.reviewedFiles && typeof reviewData.reviewedFiles === "object"
  ? { ...reviewData.reviewedFiles }
  : {};

function setupBranchComparisonSelect() {
  const comparisons = reviewData.branchComparisons || [];
  branchComparisonSelect.innerHTML = '<option value="">None</option>';
  for (const comparison of comparisons) {
    const option = document.createElement("option");
    option.value = comparison.branch;
    option.textContent = comparison.branch;
    branchComparisonSelect.appendChild(option);
  }
  branchComparisonSelect.disabled = comparisons.length === 0;
  if (comparisons.length === 0) {
    branchComparisonSelect.title = "No main or master branch found.";
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function inferLanguage(path) {
  if (!path) return "plaintext";
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".sh")) return "shell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt")) return "kotlin";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  return "plaintext";
}

function selectedBranchComparison() {
  if (!state.selectedBranch) return null;
  return (reviewData.branchComparisons || []).find((comparison) => comparison.branch === state.selectedBranch) || null;
}

function scopeLabel(scope) {
  switch (scope) {
    case "branch-diff": return selectedBranchComparison()?.label || "Branch diff";
    case "git-diff": return "Git diff";
    case "last-commit": return "Last commit";
    default: return "All files";
  }
}

function scopeHint(scope) {
  switch (scope) {
    case "branch-diff":
      return `Review current worktree changes against ${state.selectedBranch || "the selected branch"}. Hover or click line numbers in the gutter to add an inline comment.`;
    case "git-diff":
      return "Review working tree changes against HEAD. Hover or click line numbers in the gutter to add an inline comment.";
    case "last-commit":
      return "Review the last commit against its parent. Hover or click line numbers in the gutter to add an inline comment.";
    default:
      return "Review the current working tree snapshot. Hover or click line numbers in the gutter to add a code review comment.";
  }
}

function statusLabel(status) {
  if (!status) return "";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusBadgeClass(status) {
  switch (status) {
    case "added": return "text-[#3fb950]";
    case "deleted": return "text-[#f85149]";
    case "renamed": return "text-[#d29922]";
    default: return "text-[#58a6ff]";
  }
}

function reviewedFileStorageKey(file) {
  return file.path;
}

function isFilePersistentlyReviewed(file) {
  if (!file || !file.reviewFingerprint) return false;
  return persistedReviewedFiles[reviewedFileStorageKey(file)] === file.reviewFingerprint;
}

function setFilePersistentlyReviewed(file, reviewed) {
  if (!file || !file.reviewFingerprint) return;
  const fileKey = reviewedFileStorageKey(file);

  if (reviewed) {
    persistedReviewedFiles[fileKey] = file.reviewFingerprint;
  } else {
    delete persistedReviewedFiles[fileKey];
  }
}

function getReviewedFilesPayload() {
  const reviewedFiles = {};
  for (const file of reviewData.files) {
    if (isFileReviewed(file.id)) {
      reviewedFiles[reviewedFileStorageKey(file)] = file.reviewFingerprint;
    }
  }
  return reviewedFiles;
}

function isFileReviewed(fileId) {
  if (state.reviewedFiles[fileId] === true) return true;
  if (state.reviewedFiles[fileId] === false) return false;
  const file = reviewFileById.get(fileId);
  return isFilePersistentlyReviewed(file);
}

function getScopedFiles() {
  switch (state.currentScope) {
    case "branch-diff":
      return state.selectedBranch
        ? reviewData.files.filter((file) => file.inBranchDiffs?.[state.selectedBranch])
        : [];
    case "git-diff":
      return reviewData.files.filter((file) => file.inGitDiff);
    case "last-commit":
      return reviewData.files.filter((file) => file.inLastCommit);
    default:
      return reviewData.files.filter((file) => file.hasWorkingTreeFile);
  }
}

function ensureActiveFileForScope() {
  const scopedFiles = getScopedFiles();
  const selectableFiles = state.showUnreviewedOnly
    ? scopedFiles.filter((file) => !isFileReviewed(file.id))
    : scopedFiles;

  if (selectableFiles.length === 0) {
    state.activeFileId = null;
    return;
  }
  if (selectableFiles.some((file) => file.id === state.activeFileId)) {
    return;
  }
  state.activeFileId = selectableFiles[0].id;
}

function activeFile() {
  return reviewData.files.find((file) => file.id === state.activeFileId) ?? null;
}

function getScopeComparison(file, scope = state.currentScope) {
  if (!file) return null;
  if (scope === "branch-diff") return state.selectedBranch ? file.branchDiffs?.[state.selectedBranch] ?? null : null;
  if (scope === "git-diff") return file.gitDiff;
  if (scope === "last-commit") return file.lastCommit;
  return null;
}

function activeComparison() {
  return getScopeComparison(activeFile(), state.currentScope);
}

function activeFileShowsDiff() {
  return activeComparison() != null;
}

function commentMatchesScope(comment, scope = state.currentScope) {
  if (comment.scope !== scope) return false;
  if (scope !== "branch-diff") return true;
  return (comment.branch || "") === (state.selectedBranch || "");
}

function getScopeFilePath(file) {
  const comparison = getScopeComparison(file, state.currentScope);
  return comparison?.newPath || comparison?.oldPath || file?.path || "";
}

function getScopeDisplayPath(file, scope = state.currentScope) {
  const comparison = getScopeComparison(file, scope);
  return comparison?.displayPath || file?.path || "";
}

function getFileSearchPath(file) {
  return file?.path || "";
}

function getBaseName(path) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function getActiveStatus(file) {
  const comparison = getScopeComparison(file, state.currentScope);
  return comparison?.status ?? file?.worktreeStatus ?? null;
}

function normalizeQuery(query) {
  return String(query || "").trim().toLowerCase().replace(/\s+/g, "");
}

function scoreSubsequence(query, candidate) {
  if (!query) return 0;
  let queryIndex = 0;
  let score = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -2;

  for (let i = 0; i < candidate.length && queryIndex < query.length; i += 1) {
    if (candidate[i] !== query[queryIndex]) continue;

    if (firstMatchIndex === -1) firstMatchIndex = i;
    score += 10;

    if (i === previousMatchIndex + 1) {
      score += 8;
    }

    const previousChar = i > 0 ? candidate[i - 1] : "";
    if (i === 0 || previousChar === "/" || previousChar === "_" || previousChar === "-" || previousChar === ".") {
      score += 12;
    }

    previousMatchIndex = i;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) return -1;
  if (firstMatchIndex >= 0) score += Math.max(0, 20 - firstMatchIndex);
  return score;
}

function getFileSearchScore(query, file) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return 0;

  const path = getFileSearchPath(file).toLowerCase();
  const baseName = getBaseName(path);
  const pathScore = scoreSubsequence(normalizedQuery, path);
  const baseScore = scoreSubsequence(normalizedQuery, baseName);
  let score = Math.max(pathScore, baseScore >= 0 ? baseScore + 40 : -1);

  if (score < 0) return -1;
  if (baseName === normalizedQuery) score += 200;
  else if (baseName.startsWith(normalizedQuery)) score += 120;
  else if (path.includes(normalizedQuery)) score += 35;

  return score;
}

function getFilteredFiles() {
  const scopedFiles = state.showUnreviewedOnly
    ? getScopedFiles().filter((file) => !isFileReviewed(file.id))
    : getScopedFiles();
  const query = state.fileFilter.trim();
  if (!query) return [...scopedFiles];

  return scopedFiles
    .map((file) => ({ file, score: getFileSearchScore(query, file) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return getFileSearchPath(a.file).localeCompare(getFileSearchPath(b.file));
    })
    .map((entry) => entry.file);
}

function buildTree(files) {
  const root = { name: "", path: "", kind: "dir", children: new Map(), file: null };
  for (const file of files) {
    const path = getFileSearchPath(file);
    const parts = path.split("/");
    let node = root;
    let currentPath = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: currentPath,
          kind: isLeaf ? "file" : "dir",
          children: new Map(),
          file: isLeaf ? file : null,
        });
      }
      node = node.children.get(part);
      if (isLeaf) node.file = file;
    }
  }
  return root;
}

function sortedTreeChildren(node) {
  return [...node.children.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function flattenVisibleTreeFiles(node, files = []) {
  for (const child of sortedTreeChildren(node)) {
    if (child.kind === "dir") {
      if (state.collapsedDirs[child.path] !== true) {
        flattenVisibleTreeFiles(child, files);
      }
    } else if (child.file) {
      files.push(child.file);
    }
  }
  return files;
}

function getDisplayedFilesInOrder() {
  const visibleFiles = getFilteredFiles();
  return state.fileFilter.trim()
    ? visibleFiles
    : flattenVisibleTreeFiles(buildTree(visibleFiles));
}

function scopeBranchKey(scope) {
  return scope === "branch-diff" ? state.selectedBranch || "" : "";
}

function cacheKey(scope, fileId, branch = scopeBranchKey(scope)) {
  return `${scope}:${branch || ""}:${fileId}`;
}

function scrollKey(scope, fileId) {
  return `${scope}:${scopeBranchKey(scope)}:${fileId}`;
}

function saveCurrentScrollPosition() {
  if (!diffEditor || !state.activeFileId) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  state.scrollPositions[scrollKey(state.currentScope, state.activeFileId)] = {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  };
}

function restoreFileScrollPosition() {
  if (!diffEditor || !state.activeFileId) return;
  const scrollState = state.scrollPositions[scrollKey(state.currentScope, state.activeFileId)];
  if (!scrollState) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollTop(scrollState.originalTop);
  originalEditor.setScrollLeft(scrollState.originalLeft);
  modifiedEditor.setScrollTop(scrollState.modifiedTop);
  modifiedEditor.setScrollLeft(scrollState.modifiedLeft);
}

function captureScrollState() {
  if (!diffEditor) return null;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  return {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  };
}

function restoreScrollState(scrollState) {
  if (!diffEditor || !scrollState) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollTop(scrollState.originalTop);
  originalEditor.setScrollLeft(scrollState.originalLeft);
  modifiedEditor.setScrollTop(scrollState.modifiedTop);
  modifiedEditor.setScrollLeft(scrollState.modifiedLeft);
}

function getRequestState(fileId, scope = state.currentScope) {
  const key = cacheKey(scope, fileId);
  return {
    contents: state.fileContents[key],
    error: state.fileErrors[key],
    requestId: state.pendingRequestIds[key],
  };
}

function ensureFileLoaded(fileId, scope = state.currentScope) {
  if (!fileId) return;
  const key = cacheKey(scope, fileId);
  if (state.fileContents[key] != null) return;
  if (state.fileErrors[key] != null) return;
  if (state.pendingRequestIds[key] != null) return;

  const requestId = `request:${Date.now()}:${++requestSequence}`;
  state.pendingRequestIds[key] = requestId;
  renderTree();
  if (window.glimpse?.send) {
    window.glimpse.send({ type: "request-file", requestId, fileId, scope, branch: scope === "branch-diff" ? state.selectedBranch : null });
  }
}

function setExplanation(next) {
  state.explanation = { ...state.explanation, ...next };
  renderExplanationPanel();
}

function explanationStatusClass(status) {
  switch (status) {
    case "loading": return "shrink-0 rounded-full border border-[#58a6ff]/40 bg-[#58a6ff]/10 px-2 py-0.5 text-[10px] font-medium text-[#58a6ff]";
    case "ready": return "shrink-0 rounded-full border border-[#2ea043]/40 bg-[#238636]/15 px-2 py-0.5 text-[10px] font-medium text-[#3fb950]";
    case "error": return "shrink-0 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400";
    default: return "shrink-0 rounded-full border border-review-border px-2 py-0.5 text-[10px] font-medium text-review-muted";
  }
}

function renderAiMessage(message) {
  const wrapper = document.createElement("div");
  wrapper.className = message.role === "user"
    ? "rounded-lg border border-[#58a6ff]/30 bg-[#58a6ff]/10 p-3"
    : "rounded-lg border border-review-border bg-review-panel p-3";

  const label = document.createElement("div");
  label.className = "mb-2 text-[10px] font-semibold uppercase tracking-wider text-review-muted";
  label.textContent = message.role === "user" ? "You" : "AI";
  wrapper.appendChild(label);

  const body = document.createElement("div");
  body.className = "whitespace-pre-wrap text-sm leading-6 text-review-text";
  body.textContent = message.content || "";
  wrapper.appendChild(body);

  return wrapper;
}

function renderExplanationPanel() {
  const file = activeFile();
  const busy = state.explanation.status === "loading" || state.explanation.status === "chatting";
  const fileReady = file != null && isActiveFileReady();
  explainFileButton.disabled = !file || !fileReady || busy;
  explainSelectionButton.disabled = !file || !fileReady || busy;
  explanationAddCommentButton.disabled = !state.explanation.markdown || !state.explanation.source || busy;
  explanationAddOverallButton.disabled = !state.explanation.markdown || busy;
  aiChatButton.disabled = busy || aiChatInputEl.value.trim().length === 0;

  explanationTitleEl.textContent = state.explanation.title || "AI assistant";
  explanationStatusEl.textContent = state.explanation.status === "loading"
    ? "Thinking"
    : state.explanation.status === "chatting"
      ? "Replying"
      : state.explanation.status === "ready"
        ? "Ready"
        : state.explanation.status === "error"
          ? "Error"
          : "Idle";
  explanationStatusEl.className = explanationStatusClass(state.explanation.status === "chatting" ? "loading" : state.explanation.status);

  explanationOutputEl.innerHTML = "";
  const messages = state.explanation.messages || [];
  if (messages.length > 0) {
    const stack = document.createElement("div");
    stack.className = "space-y-3";
    messages.forEach((message) => stack.appendChild(renderAiMessage(message)));
    explanationOutputEl.appendChild(stack);
    explanationOutputEl.scrollTop = explanationOutputEl.scrollHeight;
    return;
  }

  const fallback = document.createElement("div");
  fallback.className = "whitespace-pre-wrap";
  if (state.explanation.status === "loading") {
    fallback.textContent = "Asking the current pi model to review this...";
  } else if (state.explanation.status === "error") {
    fallback.textContent = state.explanation.error || "Unable to generate an AI response.";
  } else if (state.explanation.markdown) {
    fallback.textContent = state.explanation.markdown;
  } else if (!file) {
    fallback.textContent = "Pick a file, then ask for an explanation or a follow-up review question.";
  } else if (!fileReady) {
    fallback.textContent = "File contents are still loading.";
  } else {
    fallback.textContent = "Use the buttons above to explain the file or selected lines, or ask a question below.";
  }
  explanationOutputEl.appendChild(fallback);
}

function selectionHasRange(selection) {
  return selection != null && (selection.startLineNumber !== selection.endLineNumber || selection.startColumn !== selection.endColumn);
}

function lineRangeFromEditor(editor) {
  const selection = editor.getSelection?.();
  if (selection != null) {
    return {
      startLine: Math.min(selection.startLineNumber, selection.endLineNumber),
      endLine: Math.max(selection.startLineNumber, selection.endLineNumber),
      hasSelection: selectionHasRange(selection),
    };
  }

  const position = editor.getPosition?.();
  const line = position?.lineNumber ?? 1;
  return { startLine: line, endLine: line, hasSelection: false };
}

function getExplainSelectionTarget() {
  const file = activeFile();
  if (!file || !diffEditor) return null;

  const candidates = [
    { side: "original", editor: diffEditor.getOriginalEditor() },
    { side: "modified", editor: diffEditor.getModifiedEditor() },
  ].filter((candidate) => canCommentOnSide(file, candidate.side));

  if (candidates.length === 0) return null;

  const focused = candidates.find((candidate) => candidate.editor.hasTextFocus?.());
  const selected = candidates.find((candidate) => selectionHasRange(candidate.editor.getSelection?.()));
  const fallback = candidates.find((candidate) => candidate.side === "modified") ?? candidates[0];
  const candidate = focused ?? selected ?? fallback;
  const range = lineRangeFromEditor(candidate.editor);

  return {
    side: candidate.side,
    startLine: range.startLine,
    endLine: range.endLine,
    hasSelection: range.hasSelection,
  };
}

function requestExplanation(kind) {
  const file = activeFile();
  if (!file) {
    sendClientLog("warn", "explanation requested without active file", { kind });
    return;
  }

  if (!isActiveFileReady()) {
    ensureFileLoaded(file.id, state.currentScope);
    setExplanation({
      status: "error",
      requestId: null,
      title: "File is loading",
      markdown: "",
      error: "Wait for this file to finish loading, then ask again.",
      source: null,
      messages: [],
    });
    return;
  }

  const requestId = `explain:${Date.now()}:${++requestSequence}`;
  const branch = state.currentScope === "branch-diff" ? state.selectedBranch : null;
  const base = {
    requestId,
    fileId: file.id,
    scope: state.currentScope,
    branch,
  };

  let payload;
  let title;
  let source;
  if (kind === "selection") {
    const selection = getExplainSelectionTarget();
    if (selection == null) {
      setExplanation({
        status: "error",
        requestId: null,
        title: "No selectable lines",
        markdown: "",
        error: "This file has no selectable side to explain.",
        source: null,
        messages: [],
      });
      return;
    }
    payload = { type: "explain-selection", ...base, side: selection.side, startLine: selection.startLine, endLine: selection.endLine };
    title = `Explaining ${getScopeDisplayPath(file, state.currentScope)}:${selection.startLine}-${selection.endLine}`;
    source = { ...base, kind, side: selection.side, startLine: selection.startLine, endLine: selection.endLine };
  } else {
    payload = { type: "explain-file", ...base };
    title = `Explaining ${getScopeDisplayPath(file, state.currentScope)}`;
    source = { ...base, kind };
  }

  setExplanation({
    status: "loading",
    requestId,
    title,
    markdown: "",
    error: "",
    source,
    messages: [],
  });

  sendClientLog("info", "requesting explanation", payload);
  if (window.glimpse?.send) {
    window.glimpse.send(payload);
  } else {
    setExplanation({
      status: "error",
      requestId,
      title,
      markdown: "",
      error: "Glimpse message bridge is unavailable.",
      source,
      messages: [],
    });
  }
}

function addExplanationToOverallNote() {
  if (!state.explanation.markdown) return;
  const title = state.explanation.title || "AI explanation";
  const addition = `AI explanation — ${title}\n\n${state.explanation.markdown}`;
  state.overallComment = [state.overallComment.trim(), addition].filter(Boolean).join("\n\n");
  renderTree();
}

function addExplanationAsComment() {
  if (!state.explanation.markdown || !state.explanation.source) return;
  const source = state.explanation.source;
  const file = reviewFileById.get(source.fileId);
  if (!file) return;

  state.comments.push({
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    fileId: file.id,
    scope: source.scope,
    branch: source.branch,
    side: source.side ?? "file",
    startLine: source.startLine ?? null,
    endLine: source.endLine ?? null,
    body: `AI explanation:\n\n${state.explanation.markdown}`,
  });
  submitButton.disabled = false;
  updateCommentsUI();
}

function requestAiChat() {
  const question = aiChatInputEl.value.trim();
  if (!question || state.explanation.status === "loading" || state.explanation.status === "chatting") return;

  const file = activeFile();
  const requestId = `ai-chat:${Date.now()}:${++requestSequence}`;
  const branch = state.currentScope === "branch-diff" ? state.selectedBranch : null;
  const previousMessages = (state.explanation.messages || []).filter((message) => message.pending !== true);
  const messages = [
    ...previousMessages,
    { role: "user", content: question },
    { role: "assistant", content: "Thinking...", pending: true },
  ];

  setExplanation({
    status: "chatting",
    requestId,
    title: state.explanation.title || "AI assistant",
    error: "",
    messages,
  });
  aiChatInputEl.value = "";
  renderExplanationPanel();

  if (window.glimpse?.send) {
    window.glimpse.send({
      type: "ai-chat",
      requestId,
      fileId: file?.id ?? null,
      scope: state.currentScope,
      branch,
      question,
      contextMarkdown: state.explanation.markdown || "",
      messages: previousMessages,
    });
  } else {
    setExplanation({
      status: "error",
      requestId,
      error: "Glimpse message bridge is unavailable.",
      messages: [...previousMessages, { role: "user", content: question }, { role: "assistant", content: "Glimpse message bridge is unavailable." }],
    });
  }
}

function openFile(fileId) {
  if (state.activeFileId === fileId) {
    ensureFileLoaded(fileId, state.currentScope);
    return;
  }
  saveCurrentScrollPosition();
  state.activeFileId = fileId;
  renderAll({ restoreFileScroll: true });
  ensureFileLoaded(fileId, state.currentScope);
}

function renderTreeNode(node, depth) {
  const children = sortedTreeChildren(node);

  const indentPx = 12;

  for (const child of children) {
    if (child.kind === "dir") {
      const collapsed = state.collapsedDirs[child.path] === true;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "group flex w-full items-center gap-1.5 px-2 py-1 text-left text-[13px] text-[#c9d1d9] hover:bg-[#21262d]";
      row.style.paddingLeft = `${depth * indentPx + 8}px`;
      row.innerHTML = `
        <svg class="h-4 w-4 shrink-0 text-[#8b949e] transition-transform ${collapsed ? "-rotate-90" : ""}" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.78 6.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 7.28a.749.749 0 0 1 1.06-1.06L8 9.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
        </svg>
        <span class="truncate">${escapeHtml(child.name)}</span>
      `;
      row.addEventListener("click", () => {
        state.collapsedDirs[child.path] = !collapsed;
        renderTree();
      });
      fileTreeEl.appendChild(row);
      if (!collapsed) renderTreeNode(child, depth + 1);
      continue;
    }

    const file = child.file;
    const count = state.comments.filter((comment) => comment.fileId === file.id && commentMatchesScope(comment)).length;
    const reviewed = isFileReviewed(file.id);
    const requestState = getRequestState(file.id, state.currentScope);
    const loading = requestState.requestId != null && requestState.contents == null;
    const errored = requestState.error != null;
    const status = getActiveStatus(file);
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "group flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[13px]",
      file.id === state.activeFileId ? "bg-[#373e47] text-white" : reviewed ? "text-[#c9d1d9] hover:bg-[#21262d]" : "text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]",
    ].join(" ");
    button.style.paddingLeft = `${(depth * indentPx) + 26}px`;
    button.innerHTML = `
      <span class="flex min-w-0 items-center gap-1.5 truncate ${file.id === state.activeFileId ? "font-medium" : ""}">
        <span class="shrink-0 text-[10px] ${reviewed ? "text-[#3fb950]" : errored ? "text-red-400" : loading ? "text-[#58a6ff]" : "text-transparent"}">${reviewed ? "●" : errored ? "!" : loading ? "…" : "●"}</span>
        <span class="truncate">${escapeHtml(child.name)}</span>
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        ${count > 0 ? `<span class="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#1f2937] px-1 text-[10px] font-medium text-[#c9d1d9]">${count}</span>` : ""}
        ${status ? `<span class="font-medium ${statusBadgeClass(status)}">${escapeHtml(statusLabel(status).charAt(0))}</span>` : ""}
      </span>
    `;
    button.addEventListener("click", () => openFile(file.id));
    fileTreeEl.appendChild(button);
  }
}

function renderSearchResults(files) {
  files.forEach((file) => {
    const path = getFileSearchPath(file);
    const baseName = getBaseName(path);
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const count = state.comments.filter((comment) => comment.fileId === file.id && commentMatchesScope(comment)).length;
    const reviewed = isFileReviewed(file.id);
    const requestState = getRequestState(file.id, state.currentScope);
    const loading = requestState.requestId != null && requestState.contents == null;
    const errored = requestState.error != null;
    const status = getActiveStatus(file);
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "group flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left",
      file.id === state.activeFileId ? "bg-[#373e47] text-white" : "text-[#c9d1d9] hover:bg-[#21262d]",
    ].join(" ");
    button.innerHTML = `
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5">
          <span class="shrink-0 text-[10px] ${reviewed ? "text-[#3fb950]" : errored ? "text-red-400" : loading ? "text-[#58a6ff]" : "text-transparent"}">${reviewed ? "●" : errored ? "!" : loading ? "…" : "●"}</span>
          <span class="truncate text-[13px] ${file.id === state.activeFileId ? "font-medium" : ""}">${escapeHtml(baseName)}</span>
        </span>
        <span class="mt-0.5 block truncate pl-[14px] text-[11px] ${file.id === state.activeFileId ? "text-[#c9d1d9]" : "text-review-muted"}">${escapeHtml(parentPath || path)}</span>
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        ${count > 0 ? `<span class="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#1f2937] px-1 text-[10px] font-medium text-[#c9d1d9]">${count}</span>` : ""}
        ${status ? `<span class="font-medium ${statusBadgeClass(status)}">${escapeHtml(statusLabel(status).charAt(0))}</span>` : ""}
      </span>
    `;
    button.addEventListener("click", () => openFile(file.id));
    fileTreeEl.appendChild(button);
  });
}

function updateSidebarLayout() {
  const collapsed = state.sidebarCollapsed;
  sidebarEl.style.width = collapsed ? "0px" : "280px";
  sidebarEl.style.minWidth = collapsed ? "0px" : "280px";
  sidebarEl.style.flexBasis = collapsed ? "0px" : "280px";
  sidebarEl.style.borderRightWidth = collapsed ? "0px" : "1px";
  sidebarEl.style.pointerEvents = collapsed ? "none" : "auto";
  toggleSidebarButton.textContent = collapsed ? "Show sidebar" : "Hide sidebar";
}

function clampAiPanelWidth(width) {
  const maxWidth = Math.max(300, Math.min(820, window.innerWidth - 520));
  return Math.max(260, Math.min(maxWidth, width));
}

function updateAiPanelLayout() {
  state.aiPanelWidth = clampAiPanelWidth(state.aiPanelWidth);
  const width = `${state.aiPanelWidth}px`;
  aiPanelEl.style.width = width;
  aiPanelEl.style.minWidth = width;
  aiPanelEl.style.flexBasis = width;
}

function updateScopeButtons() {
  const counts = {
    branch: state.selectedBranch ? reviewData.files.filter((file) => file.inBranchDiffs?.[state.selectedBranch]).length : 0,
    diff: reviewData.files.filter((file) => file.inGitDiff).length,
    lastCommit: reviewData.files.filter((file) => file.inLastCommit).length,
    all: reviewData.files.filter((file) => file.hasWorkingTreeFile).length,
  };

  const applyButtonClasses = (button, active, disabled) => {
    button.disabled = disabled;
    button.className = disabled
      ? "cursor-default rounded-md border border-review-border bg-[#11161d] px-2.5 py-1 text-[11px] font-medium text-review-muted opacity-60"
      : active
        ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-2.5 py-1 text-[11px] font-medium text-[#3fb950] hover:bg-[#238636]/25"
        : "cursor-pointer rounded-md border border-review-border bg-review-panel px-2.5 py-1 text-[11px] font-medium text-review-text hover:bg-[#21262d]";
  };

  scopeBranchButton.style.display = state.selectedBranch ? "inline-flex" : "none";
  scopeBranchButton.textContent = `${scopeLabel("branch-diff")}${counts.branch > 0 ? ` (${counts.branch})` : ""}`;
  scopeDiffButton.textContent = `Git diff${counts.diff > 0 ? ` (${counts.diff})` : ""}`;
  scopeLastCommitButton.textContent = `Last commit${counts.lastCommit > 0 ? ` (${counts.lastCommit})` : ""}`;
  scopeAllButton.textContent = `All files${counts.all > 0 ? ` (${counts.all})` : ""}`;

  applyButtonClasses(scopeBranchButton, state.currentScope === "branch-diff", counts.branch === 0);
  applyButtonClasses(scopeDiffButton, state.currentScope === "git-diff", counts.diff === 0);
  applyButtonClasses(scopeLastCommitButton, state.currentScope === "last-commit", counts.lastCommit === 0);
  applyButtonClasses(scopeAllButton, state.currentScope === "all-files", counts.all === 0);

  const unreviewedCount = getScopedFiles().filter((file) => !isFileReviewed(file.id)).length;
  filterUnreviewedButton.textContent = `Unreviewed only${unreviewedCount > 0 ? ` (${unreviewedCount})` : ""}`;
  applyButtonClasses(filterUnreviewedButton, state.showUnreviewedOnly, false);
}

function updateToggleButtons() {
  const file = activeFile();
  const reviewed = file ? isFileReviewed(file.id) : false;
  toggleReviewedButton.textContent = reviewed ? "Reviewed" : "Mark reviewed";
  toggleReviewedButton.className = reviewed
    ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-3 py-1 text-xs font-medium text-[#3fb950] hover:bg-[#238636]/25"
    : "cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1 text-xs font-medium text-review-text hover:bg-[#21262d]";
  toggleWrapButton.textContent = `Wrap lines: ${state.wrapLines ? "on" : "off"}`;
  toggleUnchangedButton.textContent = state.hideUnchanged ? "Show full file" : "Show changed areas only";
  toggleUnchangedButton.style.display = activeFileShowsDiff() ? "inline-flex" : "none";
  updateScopeButtons();
  modeHintEl.textContent = scopeHint(state.currentScope);
  submitButton.disabled = false;
  renderExplanationPanel();
}

function applyEditorOptions() {
  if (!diffEditor) return;
  diffEditor.updateOptions({
    renderSideBySide: activeFileShowsDiff(),
    diffWordWrap: state.wrapLines ? "on" : "off",
    hideUnchangedRegions: {
      enabled: activeFileShowsDiff() && state.hideUnchanged,
      contextLineCount: 4,
      minimumLineCount: 2,
      revealLineCount: 12,
    },
  });
  diffEditor.getOriginalEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
  diffEditor.getModifiedEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
}

function renderTree() {
  ensureActiveFileForScope();
  fileTreeEl.innerHTML = "";
  const scopedFiles = getScopedFiles();
  const visibleFiles = getFilteredFiles();

  if (visibleFiles.length === 0) {
    const message = state.fileFilter.trim()
      ? `No files match <span class="text-review-text">${escapeHtml(state.fileFilter.trim())}</span>${state.showUnreviewedOnly ? " among unreviewed files" : ""}.`
      : state.showUnreviewedOnly
        ? `No unreviewed files in <span class="text-review-text">${escapeHtml(scopeLabel(state.currentScope).toLowerCase())}</span>.`
        : `No files in <span class="text-review-text">${escapeHtml(scopeLabel(state.currentScope).toLowerCase())}</span>.`;
    fileTreeEl.innerHTML = `
      <div class="px-3 py-4 text-sm text-review-muted">
        ${message}
      </div>
    `;
  } else if (state.fileFilter.trim()) {
    renderSearchResults(visibleFiles);
  } else {
    renderTreeNode(buildTree(visibleFiles), 0);
  }

  sidebarTitleEl.textContent = scopeLabel(state.currentScope);
  const comments = state.comments.length;
  const filteredSuffix = state.fileFilter.trim() || state.showUnreviewedOnly ? ` • ${visibleFiles.length} shown` : "";
  summaryEl.textContent = `${scopedFiles.length} file(s) • ${comments} comment(s)${state.overallComment ? " • overall note" : ""}${filteredSuffix}`;
  updateToggleButtons();
  updateSidebarLayout();
}

function showTextModal(options) {
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-white">${escapeHtml(options.title)}</div>
      <div class="mb-4 text-sm text-review-muted">${escapeHtml(options.description)}</div>
      <textarea id="review-modal-text" class="scrollbar-thin min-h-48 w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">${escapeHtml(options.initialValue ?? "")}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="review-modal-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Cancel</button>
        <button id="review-modal-save" class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#238636] px-4 py-2 text-sm font-medium text-white hover:bg-[#2ea043]">${escapeHtml(options.saveLabel ?? "Save")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const textarea = backdrop.querySelector("#review-modal-text");
  const close = () => backdrop.remove();
  backdrop.querySelector("#review-modal-cancel").addEventListener("click", close);
  backdrop.querySelector("#review-modal-save").addEventListener("click", () => {
    options.onSave(textarea.value.trim());
    close();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  textarea.focus();
}

function showOverallCommentModal() {
  showTextModal({
    title: "Overall review note",
    description: "This note is prepended to the generated prompt above the inline comments.",
    initialValue: state.overallComment,
    saveLabel: "Save note",
    onSave: (value) => {
      state.overallComment = value;
      renderTree();
    },
  });
}

function showFileCommentModal() {
  const file = activeFile();
  if (!file) return;
  showTextModal({
    title: `File comment for ${getScopeDisplayPath(file, state.currentScope)}`,
    description: `This comment applies to the whole file in ${scopeLabel(state.currentScope).toLowerCase()}.`,
    initialValue: "",
    saveLabel: "Add comment",
    onSave: (value) => {
      if (!value) return;
      state.comments.push({
        id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
        fileId: file.id,
        scope: state.currentScope,
        branch: state.currentScope === "branch-diff" ? state.selectedBranch : null,
        side: "file",
        startLine: null,
        endLine: null,
        body: value,
      });
      submitButton.disabled = false;
      updateCommentsUI();
    },
  });
}

function layoutEditor() {
  if (!diffEditor) return;
  const width = editorContainerEl.clientWidth;
  const height = editorContainerEl.clientHeight;
  if (width <= 0 || height <= 0) return;
  diffEditor.layout({ width, height });
}

function setupAiPanelResizer() {
  let dragging = false;

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    aiPanelResizerEl.classList.remove("is-dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  aiPanelResizerEl.addEventListener("pointerdown", (event) => {
    dragging = true;
    aiPanelResizerEl.classList.add("is-dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    aiPanelResizerEl.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  window.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    state.aiPanelWidth = window.innerWidth - event.clientX;
    updateAiPanelLayout();
    requestAnimationFrame(layoutEditor);
  });

  window.addEventListener("pointerup", stopDragging);
  window.addEventListener("pointercancel", stopDragging);
  window.addEventListener("resize", () => {
    updateAiPanelLayout();
    requestAnimationFrame(layoutEditor);
  });
}

function clearViewZones() {
  if (!diffEditor || activeViewZones.length === 0) return;
  const original = diffEditor.getOriginalEditor();
  const modified = diffEditor.getModifiedEditor();
  original.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === original) accessor.removeZone(zone.id);
  });
  modified.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === modified) accessor.removeZone(zone.id);
  });
  activeViewZones = [];
}

function renderCommentDOM(comment, onDelete) {
  const container = document.createElement("div");
  container.className = "view-zone-container";
  const title = comment.side === "file"
    ? `File comment • ${scopeLabel(comment.scope)}`
    : `${comment.side === "original" ? "Original" : "Modified"} line ${comment.startLine} • ${scopeLabel(comment.scope)}`;

  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="text-xs font-semibold text-review-text">${escapeHtml(title)}</div>
      <button data-action="delete" class="cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-red-500/10 hover:text-red-400">Delete</button>
    </div>
    <textarea data-comment-id="${escapeHtml(comment.id)}" class="scrollbar-thin min-h-[76px] w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="Leave a comment"></textarea>
  `;
  const textarea = container.querySelector("textarea");
  textarea.value = comment.body || "";
  textarea.addEventListener("input", () => {
    comment.body = textarea.value;
  });
  container.querySelector("[data-action='delete']").addEventListener("click", onDelete);
  if (!comment.body) setTimeout(() => textarea.focus(), 50);
  return container;
}

function canCommentOnSide(file, side) {
  if (!file) return false;
  const comparison = activeComparison();
  if (side === "original") {
    return comparison != null && comparison.hasOriginal;
  }
  return comparison != null ? comparison.hasModified : file.hasWorkingTreeFile;
}

function isActiveFileReady() {
  const file = activeFile();
  if (!file) return false;
  const requestState = getRequestState(file.id, state.currentScope);
  return requestState.contents != null && requestState.error == null;
}

function syncViewZones() {
  clearViewZones();
  if (!diffEditor || !isActiveFileReady()) return;
  const file = activeFile();
  if (!file) return;

  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  const inlineComments = state.comments.filter((comment) => comment.fileId === file.id && commentMatchesScope(comment) && comment.side !== "file");

  inlineComments.forEach((item) => {
    const editor = item.side === "original" ? originalEditor : modifiedEditor;
    const domNode = renderCommentDOM(item, () => {
      state.comments = state.comments.filter((comment) => comment.id !== item.id);
      updateCommentsUI();
    });

    editor.changeViewZones((accessor) => {
      const lineCount = typeof item.body === "string" && item.body.length > 0 ? item.body.split("\n").length : 1;
      const id = accessor.addZone({
        afterLineNumber: item.startLine,
        heightInPx: Math.max(150, lineCount * 22 + 86),
        domNode,
      });
      activeViewZones.push({ id, editor });
    });
  });
}

function updateDecorations() {
  if (!diffEditor || !monacoApi) return;
  const file = activeFile();
  const comments = file ? state.comments.filter((comment) => comment.fileId === file.id && commentMatchesScope(comment) && comment.side !== "file") : [];
  const originalRanges = [];
  const modifiedRanges = [];

  for (const comment of comments) {
    const range = {
      range: new monacoApi.Range(comment.startLine, 1, comment.startLine, 1),
      options: {
        isWholeLine: true,
        className: comment.side === "original" ? "review-comment-line-original" : "review-comment-line-modified",
        glyphMarginClassName: comment.side === "original" ? "review-comment-glyph-original" : "review-comment-glyph-modified",
      },
    };
    if (comment.side === "original") originalRanges.push(range);
    else modifiedRanges.push(range);
  }

  originalDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalDecorations, originalRanges);
  modifiedDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedDecorations, modifiedRanges);
}

function renderFileComments() {
  fileCommentsContainer.innerHTML = "";
  const file = activeFile();
  if (!file) {
    fileCommentsContainer.className = "hidden overflow-hidden px-0 py-0";
    return;
  }

  const fileComments = state.comments.filter((comment) => comment.fileId === file.id && commentMatchesScope(comment) && comment.side === "file");

  if (fileComments.length === 0) {
    fileCommentsContainer.className = "hidden overflow-hidden px-0 py-0";
    return;
  }

  fileCommentsContainer.className = "border-b border-review-border bg-[#0d1117] px-4 py-4 space-y-4";
  fileComments.forEach((comment) => {
    const dom = renderCommentDOM(comment, () => {
      state.comments = state.comments.filter((item) => item.id !== comment.id);
      updateCommentsUI();
    });
    dom.className = "rounded-lg border border-review-border bg-review-panel p-4";
    fileCommentsContainer.appendChild(dom);
  });
}

function getPlaceholderContents(file, scope) {
  const path = getScopeDisplayPath(file, scope);
  const requestState = getRequestState(file.id, scope);
  if (requestState.error) {
    const body = `Failed to load ${path}\n\n${requestState.error}`;
    return { originalContent: body, modifiedContent: body };
  }
  const body = `Loading ${path}...`;
  return { originalContent: body, modifiedContent: body };
}

function getMountedContents(file, scope = state.currentScope) {
  return getRequestState(file.id, scope).contents || getPlaceholderContents(file, scope);
}

function mountFile(options = {}) {
  if (!diffEditor || !monacoApi) return;
  const file = activeFile();
  if (!file) {
    currentFileLabelEl.textContent = "No file selected";
    clearViewZones();
    if (originalModel) originalModel.dispose();
    if (modifiedModel) modifiedModel.dispose();
    originalModel = monacoApi.editor.createModel("", "plaintext");
    modifiedModel = monacoApi.editor.createModel("", "plaintext");
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    applyEditorOptions();
    updateDecorations();
    renderFileComments();
    requestAnimationFrame(layoutEditor);
    return;
  }

  ensureFileLoaded(file.id, state.currentScope);

  const preserveScroll = options.preserveScroll === true;
  const scrollState = preserveScroll ? captureScrollState() : null;
  const language = inferLanguage(getScopeFilePath(file) || file.path);
  const contents = getMountedContents(file, state.currentScope);

  clearViewZones();
  currentFileLabelEl.textContent = getScopeDisplayPath(file, state.currentScope);

  if (originalModel) originalModel.dispose();
  if (modifiedModel) modifiedModel.dispose();

  originalModel = monacoApi.editor.createModel(contents.originalContent, language);
  modifiedModel = monacoApi.editor.createModel(contents.modifiedContent, language);

  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  applyEditorOptions();
  syncViewZones();
  updateDecorations();
  renderFileComments();
  requestAnimationFrame(() => {
    layoutEditor();
    if (options.restoreFileScroll) restoreFileScrollPosition();
    if (options.preserveScroll) restoreScrollState(scrollState);
    setTimeout(() => {
      layoutEditor();
      if (options.restoreFileScroll) restoreFileScrollPosition();
      if (options.preserveScroll) restoreScrollState(scrollState);
    }, 50);
  });
}

function syncCommentBodiesFromDOM() {
  const textareas = document.querySelectorAll("textarea[data-comment-id]");
  textareas.forEach((textarea) => {
    const commentId = textarea.getAttribute("data-comment-id");
    const comment = state.comments.find((item) => item.id === commentId);
    if (comment) comment.body = textarea.value;
  });
}

function updateCommentsUI() {
  renderTree();
  syncViewZones();
  updateDecorations();
  renderFileComments();
}

function renderAll(options = {}) {
  renderTree();
  submitButton.disabled = false;
  if (diffEditor && monacoApi) {
    mountFile(options);
    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
    });
  } else {
    renderFileComments();
  }
}

function createGlyphHoverActions(editor, side) {
  let hoverDecoration = [];

  function openDraftAtLine(line) {
    const file = activeFile();
    if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) return;
    state.comments.push({
      id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
      fileId: file.id,
      scope: state.currentScope,
      branch: state.currentScope === "branch-diff" ? state.selectedBranch : null,
      side,
      startLine: line,
      endLine: line,
      body: "",
    });
    updateCommentsUI();
    editor.revealLineInCenter(line);
  }

  editor.onMouseMove((event) => {
    const file = activeFile();
    if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
      return;
    }

    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      hoverDecoration = editor.deltaDecorations(hoverDecoration, [{
        range: new monacoApi.Range(line, 1, line, 1),
        options: { glyphMarginClassName: "review-glyph-plus" },
      }]);
    } else {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
    }
  });

  editor.onMouseLeave(() => {
    hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
  });

  editor.onMouseDown((event) => {
    const file = activeFile();
    if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) return;

    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      openDraftAtLine(line);
    }
  });
}

window.__reviewReceive = function (message) {
  if (!message || typeof message !== "object") return;
  const key = cacheKey(message.scope, message.fileId, message.branch);

  if (message.type === "explanation-data") {
    sendClientLog("info", "received explanation", { requestId: message.requestId, chars: (message.markdown || "").length });
    if (state.explanation.requestId !== message.requestId) return;
    setExplanation({
      status: "ready",
      requestId: message.requestId,
      title: message.title || "Explanation",
      markdown: message.markdown || "No explanation returned.",
      error: "",
      source: state.explanation.source,
      messages: [{ role: "assistant", content: message.markdown || "No explanation returned." }],
    });
    return;
  }

  if (message.type === "explanation-error") {
    sendClientLog("error", "received explanation error", { requestId: message.requestId, message: message.message });
    if (state.explanation.requestId !== message.requestId) return;
    setExplanation({
      status: "error",
      requestId: message.requestId,
      title: message.title || "Explanation failed",
      markdown: "",
      error: message.message || "Unable to generate an explanation.",
      source: state.explanation.source,
      messages: [],
    });
    return;
  }

  if (message.type === "ai-chat-data") {
    if (state.explanation.requestId !== message.requestId) return;
    const messages = [...(state.explanation.messages || [])];
    const pendingIndex = messages.findIndex((item) => item.pending === true);
    if (pendingIndex >= 0) messages.splice(pendingIndex, 1, { role: "assistant", content: message.markdown || "No answer returned." });
    else messages.push({ role: "assistant", content: message.markdown || "No answer returned." });
    setExplanation({
      status: "ready",
      requestId: message.requestId,
      markdown: message.markdown || "No answer returned.",
      error: "",
      messages,
    });
    return;
  }

  if (message.type === "ai-chat-error") {
    if (state.explanation.requestId !== message.requestId) return;
    const messages = [...(state.explanation.messages || [])];
    const pendingIndex = messages.findIndex((item) => item.pending === true);
    const errorText = message.message || "Unable to answer that question.";
    if (pendingIndex >= 0) messages.splice(pendingIndex, 1, { role: "assistant", content: errorText });
    else messages.push({ role: "assistant", content: errorText });
    setExplanation({
      status: "error",
      requestId: message.requestId,
      markdown: "",
      error: errorText,
      messages,
    });
    return;
  }

  if (message.type === "file-data") {
    state.fileContents[key] = {
      originalContent: message.originalContent,
      modifiedContent: message.modifiedContent,
    };
    delete state.fileErrors[key];
    delete state.pendingRequestIds[key];
    renderTree();
    if (state.activeFileId === message.fileId && state.currentScope === message.scope && scopeBranchKey(message.scope) === (message.branch || "")) {
      mountFile({ restoreFileScroll: true });
    }
    return;
  }

  if (message.type === "file-error") {
    state.fileErrors[key] = message.message || "Unknown error";
    delete state.pendingRequestIds[key];
    renderTree();
    if (state.activeFileId === message.fileId && state.currentScope === message.scope && scopeBranchKey(message.scope) === (message.branch || "")) {
      mountFile({ preserveScroll: false });
    }
  }
};

function setupMonaco() {
  window.require.config({
    paths: {
      vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs",
    },
  });

  window.require(["vs/editor/editor.main"], function () {
    monacoApi = window.monaco;

    monacoApi.editor.defineTheme("review-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0d1117",
        "diffEditor.insertedTextBackground": "#2ea04326",
        "diffEditor.removedTextBackground": "#f8514926",
      },
    });
    monacoApi.editor.setTheme("review-dark");

    diffEditor = monacoApi.editor.createDiffEditor(editorContainerEl, {
      automaticLayout: true,
      renderSideBySide: activeFileShowsDiff(),
      readOnly: true,
      originalEditable: false,
      minimap: { enabled: true, renderCharacters: false, showSlider: "always", size: "proportional" },
      renderOverviewRuler: true,
      diffWordWrap: "on",
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 4,
      glyphMargin: true,
      folding: true,
      lineDecorationsWidth: 10,
      overviewRulerBorder: false,
      wordWrap: "on",
    });

    createGlyphHoverActions(diffEditor.getOriginalEditor(), "original");
    createGlyphHoverActions(diffEditor.getModifiedEditor(), "modified");

    if (typeof ResizeObserver !== "undefined") {
      editorResizeObserver = new ResizeObserver(() => {
        layoutEditor();
      });
      editorResizeObserver.observe(editorContainerEl);
    }

    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
      setTimeout(layoutEditor, 150);
    });

    mountFile();
  });
}

function switchScope(scope) {
  const hasScopeFiles = {
    "branch-diff": state.selectedBranch ? reviewData.files.some((file) => file.inBranchDiffs?.[state.selectedBranch]) : false,
    "git-diff": reviewData.files.some((file) => file.inGitDiff),
    "last-commit": reviewData.files.some((file) => file.inLastCommit),
    "all-files": reviewData.files.some((file) => file.hasWorkingTreeFile),
  };
  if (!hasScopeFiles[scope] || state.currentScope === scope) return;
  saveCurrentScrollPosition();
  state.currentScope = scope;
  renderAll({ restoreFileScroll: true });
  const file = activeFile();
  if (file) ensureFileLoaded(file.id, state.currentScope);
}

submitButton.addEventListener("click", () => {
  syncCommentBodiesFromDOM();
  const payload = {
    type: "submit",
    overallComment: state.overallComment.trim(),
    comments: state.comments
      .map((comment) => ({ ...comment, body: comment.body.trim() }))
      .filter((comment) => comment.body.length > 0),
    reviewedFiles: getReviewedFilesPayload(),
  };
  window.glimpse.send(payload);
  window.glimpse.close();
});

cancelButton.addEventListener("click", () => {
  window.glimpse.send({ type: "cancel" });
  window.glimpse.close();
});

overallCommentButton.addEventListener("click", () => {
  showOverallCommentModal();
});

fileCommentButton.addEventListener("click", () => {
  showFileCommentModal();
});

explainFileButton.addEventListener("click", () => {
  requestExplanation("file");
});

explainSelectionButton.addEventListener("click", () => {
  requestExplanation("selection");
});

explanationAddCommentButton.addEventListener("click", () => {
  addExplanationAsComment();
});

explanationAddOverallButton.addEventListener("click", () => {
  addExplanationToOverallNote();
});

aiChatButton.addEventListener("click", () => {
  requestAiChat();
});

aiChatInputEl.addEventListener("input", () => {
  renderExplanationPanel();
});

aiChatInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    requestAiChat();
  }
});

toggleUnchangedButton.addEventListener("click", () => {
  state.hideUnchanged = !state.hideUnchanged;
  applyEditorOptions();
  updateToggleButtons();
  requestAnimationFrame(layoutEditor);
});

toggleWrapButton.addEventListener("click", () => {
  state.wrapLines = !state.wrapLines;
  applyEditorOptions();
  updateToggleButtons();
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
});

toggleReviewedButton.addEventListener("click", () => {
  const file = activeFile();
  if (!file) return;
  const visibleIndex = getDisplayedFilesInOrder().findIndex((item) => item.id === file.id);
  const reviewed = !isFileReviewed(file.id);
  state.reviewedFiles[file.id] = reviewed;
  setFilePersistentlyReviewed(file, reviewed);

  if (reviewed && state.showUnreviewedOnly) {
    const remainingFiles = getDisplayedFilesInOrder();
    const nextFile = remainingFiles[visibleIndex] ?? remainingFiles[visibleIndex - 1] ?? remainingFiles[0] ?? null;
    state.activeFileId = nextFile?.id ?? null;
  }

  renderAll({ restoreFileScroll: true });
});

branchComparisonSelect.addEventListener("change", () => {
  saveCurrentScrollPosition();
  state.selectedBranch = branchComparisonSelect.value || null;
  if (state.selectedBranch) {
    if (state.currentScope === "branch-diff") {
      renderAll({ restoreFileScroll: true });
      const file = activeFile();
      if (file) ensureFileLoaded(file.id, state.currentScope);
    } else {
      const previousScope = state.currentScope;
      switchScope("branch-diff");
      if (state.currentScope === previousScope) {
        renderAll({ restoreFileScroll: true });
      }
    }
  } else if (state.currentScope === "branch-diff") {
    switchScope(reviewData.files.some((file) => file.inGitDiff) ? "git-diff" : reviewData.files.some((file) => file.inLastCommit) ? "last-commit" : "all-files");
  } else {
    renderAll({ restoreFileScroll: true });
  }
});

scopeBranchButton.addEventListener("click", () => {
  switchScope("branch-diff");
});

scopeDiffButton.addEventListener("click", () => {
  switchScope("git-diff");
});

scopeLastCommitButton.addEventListener("click", () => {
  switchScope("last-commit");
});

scopeAllButton.addEventListener("click", () => {
  switchScope("all-files");
});

filterUnreviewedButton.addEventListener("click", () => {
  state.showUnreviewedOnly = !state.showUnreviewedOnly;
  renderTree();
});

toggleSidebarButton.addEventListener("click", () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  updateSidebarLayout();
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
});

sidebarSearchInputEl.addEventListener("input", () => {
  state.fileFilter = sidebarSearchInputEl.value;
  renderTree();
});

sidebarSearchInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    sidebarSearchInputEl.value = "";
    state.fileFilter = "";
    renderTree();
  }
});

setupBranchComparisonSelect();
ensureActiveFileForScope();
updateAiPanelLayout();
setupAiPanelResizer();
renderTree();
renderFileComments();
updateSidebarLayout();
setupMonaco();

if (window.glimpse?.send) {
  window.glimpse.send({ type: "client-ready" });
}
