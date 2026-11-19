export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "blocked"
  | "failed"
  | "cancelled"
  | "timed_out";
export interface Criterion {
  id: string;
  description: string;
  weight: number;
  required: boolean;
  appliesTo?: string[];
}
export interface Source {
  id: string;
  kind: string;
  url: string;
  score: number;
  reason: string;
  guidance: string;
}
export interface Page {
  pdf?: { sha256: string; pages: number };
  mapEmbeds?: string[];
  images?: { url: string; alt: string }[];
  productOffer?: import("./product-offer.js").ProductOffer;
  acquisition?: {
    kind: "browser-dom" | "public-html" | "public-json" | "public-pdf";
    status?: number;
    charset?: string;
    contentType?: string;
  };
  id: string;
  url: string;
  title: string;
  text: string;
  links: { text: string; url: string }[];
  capturedAt: string;
  truncated: boolean;
}
export interface Evidence {
  id: string;
  pageId: string;
  url: string;
  quote: string;
  capturedAt: string;
}
export interface Match {
  criterionId: string;
  status: "supported" | "unknown" | "contradicted";
  explanation: string;
  evidenceIds: string[];
}
export interface Candidate {
  name: string;
  url: string;
  matches: Match[];
  score: number;
  eligible: boolean;
}
export interface Answer {
  visualArtifact?: import("./visual-artifact.js").VisualArtifact;
  actionPlan?: import("./answer-plan.js").ActionPlan;
  summary: string;
  candidates: Candidate[];
  limitations: string[];
}
export interface Task {
  journeyPolicy?: ReturnType<typeof import("./journey-state.js").journeyPolicy>;
  journeyMemory?: import("./journey-state.js").JourneyMemory;
  journeyAssessment?: ReturnType<
    typeof import("./journey-state.js").assessJourneyState
  >;
  tripBrief?: ReturnType<typeof import("./trip-brief.js").tripBrief>;
  stepVerification?: ReturnType<
    typeof import("./step-verifier.js").verifyStepPlan
  >;
  pdfInspections?: {
    pageId: string;
    pageNumber: number;
    sha256: string;
    shownAt: string;
  }[];
  authorship?: {
    mode: "source-grounded-final-edit";
    editor: "Codex";
    sourceTaskId: string;
    sourceCollectionModel?: string;
    note: string;
  };
  uxLearningContext?: Awaited<
    ReturnType<import("./ux-feedback.js").UxFeedbackStore["learningContext"]>
  >;
  reviewContext?: Awaited<
    ReturnType<
      import("./review-perspectives.js").ReviewPerspectiveStore["context"]
    >
  >;
  socialSignals?: import("./social.js").SocialSignal[];
  socialResearch?: import("./social.js").SocialAttempt[];
  photoInspections?: {
    pageId: string;
    imageIndex: number;
    file: string;
    sourceUrl: string;
    type: string;
    shownAt: string;
  }[];
  answerPhotos?: Record<
    string,
    {
      file: string;
      pageId: string;
      imageIndex: number;
      sourceUrl: string;
      type: string;
      capturedAt: string;
    }
  >;
  visualRefinement?: {
    version: 1;
    sourceTaskId: string;
    mode: "captured-data-only";
  };
  visualReview?: {
    version: 1;
    status: "passed" | "needs_visual" | "not_required";
    issues: string[];
  };
  specificity?: import("./answer-plan.js").SpecificityReview;
  security?: {
    profileId: import("./runtime-profile.js").ResearchProfile["id"];
    profileVersion: 1;
    mode: import("./runtime-profile.js").SecurityMode;
    policyHash: string;
    artifactNonce?: string;
  };
  reviewWarnings?: string[];
  interactionMode?: import("./interaction.js").InteractionMode;
  execution?: {
    target: "local" | "openshell";
    isolation: "host-process" | "openshell-sandbox";
    gateway?: string;
    sandboxName?: string;
    sandboxId?: string;
    image?: string;
    artifactsDirectory?: string;
    elapsedMs?: number;
    cleanupStatus?: "stopped" | "unconfirmed";
    allocation?: "account-worker";
    runtimeRevision?: string;
    innerSandbox?: "externalSandbox";
  };
  metrics?: {
    elapsedMs: number;
    tokenAccounting?:
      "provider-reported" | "last-observed-partial" | "unavailable";
    tokens: import("./metrics.js").TokenUsage | null;
    billing: {
      mode: string;
      additionalApiUsd: number | null;
      subscriptionAllocationUsd: null;
      note: string;
    };
  };
  evaluation?: { mode: "frozen-replay"; caseId: string; fixtureSha256: string };
  reviewSignals?: import("./reviews.js").ReviewSignal[];
  improvement?: import("./improvement-context.js").ImprovementContext;
  id: string;
  parentId?: string;
  goalId?: string;
  query: string;
  urls: string[];
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  model?: string;
  agent?: import("./codex.js").AgentEngine;
  sources: Source[];
  failure?: import("./failures.js").RuntimeFailure;
  research?: {
    rounds: number;
    maxRounds: number;
    pagesOpened: number;
    maxPages: number;
    attempts: {
      pageId: string;
      url: string;
      mode: string;
      fields: string[];
      result: string;
    }[];
  };
  retrieval?: {
    status: "verified" | "insufficient_detail";
    verifiedDetailUrls: string[];
    checkedPages: number;
  };
  criteria: Criterion[];
  pages: Page[];
  evidence: Evidence[];
  answer?: Answer;
  error?: string;
  limits: { maxSteps: number; timeoutSeconds: number; maxPages: number };
  steps: number;
}
