export type ReviewScope = "branch-diff" | "git-diff" | "last-commit" | "all-files";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface ReviewFileComparison {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  hasOriginal: boolean;
  hasModified: boolean;
}

export interface ReviewFile {
  id: string;
  path: string;
  reviewFingerprint: string;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
  inBranchDiffs: Record<string, boolean>;
  inGitDiff: boolean;
  inLastCommit: boolean;
  branchDiffs: Record<string, ReviewFileComparison | null>;
  gitDiff: ReviewFileComparison | null;
  lastCommit: ReviewFileComparison | null;
}

export interface ReviewFileContents {
  originalContent: string;
  modifiedContent: string;
}

export type CommentSide = "original" | "modified" | "file";

export interface DiffReviewComment {
  id: string;
  fileId: string;
  scope: ReviewScope;
  branch: string | null;
  side: CommentSide;
  startLine: number | null;
  endLine: number | null;
  body: string;
}

export interface ReviewSubmitPayload {
  type: "submit";
  overallComment: string;
  comments: DiffReviewComment[];
  reviewedFiles: Record<string, string>;
}

export interface ReviewCancelPayload {
  type: "cancel";
}

export interface ReviewRequestFilePayload {
  type: "request-file";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  branch: string | null;
}

export interface ReviewExplainFilePayload {
  type: "explain-file";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  branch: string | null;
}

export interface ReviewExplainSelectionPayload {
  type: "explain-selection";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  branch: string | null;
  side: "original" | "modified";
  startLine: number;
  endLine: number;
}

export interface ReviewClientLogPayload {
  type: "client-log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  details?: unknown;
}

export interface ReviewClientReadyPayload {
  type: "client-ready";
}

export interface ReviewChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ReviewAiChatPayload {
  type: "ai-chat";
  requestId: string;
  fileId: string | null;
  scope: ReviewScope;
  branch: string | null;
  question: string;
  contextMarkdown: string;
  messages: ReviewChatMessage[];
}

export type ReviewWindowMessage = ReviewSubmitPayload | ReviewCancelPayload | ReviewRequestFilePayload | ReviewExplainFilePayload | ReviewExplainSelectionPayload | ReviewClientLogPayload | ReviewClientReadyPayload | ReviewAiChatPayload;

export interface ReviewFileDataMessage {
  type: "file-data";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  branch: string | null;
  originalContent: string;
  modifiedContent: string;
}

export interface ReviewFileErrorMessage {
  type: "file-error";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  branch: string | null;
  message: string;
}

export interface ReviewExplanationDataMessage {
  type: "explanation-data";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  branch: string | null;
  title: string;
  markdown: string;
}

export interface ReviewExplanationErrorMessage {
  type: "explanation-error";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  branch: string | null;
  title: string;
  message: string;
}

export interface ReviewAiChatDataMessage {
  type: "ai-chat-data";
  requestId: string;
  markdown: string;
}

export interface ReviewAiChatErrorMessage {
  type: "ai-chat-error";
  requestId: string;
  message: string;
}

export type ReviewHostMessage = ReviewFileDataMessage | ReviewFileErrorMessage | ReviewExplanationDataMessage | ReviewExplanationErrorMessage | ReviewAiChatDataMessage | ReviewAiChatErrorMessage;

export interface BranchComparison {
  branch: string;
  baseRevision: string;
  label: string;
}

export interface ReviewWindowData {
  repoRoot: string;
  files: ReviewFile[];
  reviewedFiles: Record<string, string>;
  branchComparisons: BranchComparison[];
}
