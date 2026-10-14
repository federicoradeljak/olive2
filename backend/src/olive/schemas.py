"""Pydantic schemas and domain models (port of packages/shared/src/{types,schemas}.ts)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

MeetingSource = Literal["plaud", "upload", "ios-shortcut"]
MeetingStatus = Literal["pending", "processing", "ready", "error", "duplicate"]
ArtifactKind = Literal["transcript", "summary"]
ArtifactFormat = Literal["md", "txt", "json", "srt"]
StageRunStatus = Literal["pending", "running", "done", "error", "cancelled"]
LogLevel = Literal["debug", "info", "warn", "error"]
ChatMessageRole = Literal["user", "assistant"]
TranscriptionProgressStage = Literal[
    "queued",
    "decoding",
    "uploading",
    "diarizing",
    "transcribing",
    "finalizing",
    "done",
    "error",
    "cancelled",
]
LlmThinkingLevel = Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"]


class CamelModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class ChatUsage(CamelModel):
    inputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    cost: float | None = None


class ChatMessage(CamelModel):
    id: str
    meetingId: str
    role: ChatMessageRole
    content: str
    provider: str | None = None
    model: str | None = None
    usage: ChatUsage | None = None
    createdAt: int


class Template(CamelModel):
    id: str
    name: str
    description: str | None = None
    systemPrompt: str
    userPrompt: str
    isDefault: bool
    isBuiltin: bool
    createdAt: int
    updatedAt: int


class CreateTemplateInput(CamelModel):
    name: str
    description: str | None = None
    systemPrompt: str = ""
    userPrompt: str
    isDefault: bool = False

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        s = v.strip()
        if not s:
            raise ValueError("Template name is required")
        return s

    @field_validator("description")
    @classmethod
    def _validate_desc(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return v.strip()

    @field_validator("userPrompt")
    @classmethod
    def _validate_user_prompt(cls, v: str) -> str:
        s = v.strip()
        if not s:
            raise ValueError("User prompt template is required")
        return s


class UpdateTemplateInput(CamelModel):
    name: str | None = None
    description: str | None = Field(default=None)
    systemPrompt: str | None = None
    userPrompt: str | None = None
    isDefault: bool | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        s = v.strip()
        if not s:
            raise ValueError("Template name cannot be empty")
        return s

    @field_validator("description")
    @classmethod
    def _validate_desc(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return v.strip()

    @field_validator("userPrompt")
    @classmethod
    def _validate_user_prompt(cls, v: str | None) -> str | None:
        if v is None:
            return None
        s = v.strip()
        if not s:
            raise ValueError("User prompt template cannot be empty")
        return s


class Meeting(CamelModel):
    id: str
    title: str
    startTime: int
    endTime: int
    source: MeetingSource
    status: MeetingStatus
    tags: list[str] = Field(default_factory=list)
    primaryTranscriptArtifactId: str | None = None
    primarySummaryArtifactId: str | None = None
    lastError: str | None = None
    createdAt: int
    updatedAt: int


MeetingListItem = Meeting


class Recording(CamelModel):
    id: str
    meetingId: str
    path: str
    mime: str
    durationMs: int | None = None
    sizeBytes: int
    sha256: str
    provider: MeetingSource
    providerRecordingId: str | None = None
    createdAt: int


class Artifact(CamelModel):
    id: str
    meetingId: str
    recordingId: str | None = None
    kind: ArtifactKind
    provider: str
    format: ArtifactFormat
    path: str
    createdAt: int


class Speaker(CamelModel):
    id: str
    name: str
    providerIds: dict[str, list[str]] = Field(default_factory=dict)
    enrolledAt: int | None = None
    enrollmentClipPaths: list[str] = Field(default_factory=list)
    createdAt: int


class MeetingSpeaker(CamelModel):
    meetingId: str
    speakerId: str
    evidenceArtifactId: str | None = None


class StageRunRow(CamelModel):
    id: str
    meeting_id: str
    stage: str
    status: StageRunStatus
    provider_job_id: str | None = None
    attempts: int = 0
    last_error: str | None = None
    started_at: int | None = None
    finished_at: int | None = None
    created_at: int
    updated_at: int


class TranscriptWord(CamelModel):
    startMs: int
    endMs: int
    word: str
    confidence: float | None = None
    speaker: str | None = None


class TranscriptSegment(CamelModel):
    startMs: int
    endMs: int
    speaker: str
    text: str
    verified: bool | None = None
    words: list[TranscriptWord] | None = None


class TranscriptSpeakerInfo(CamelModel):
    label: str | None = None
    speaker: str | None = None
    speaker_identifiers: list[str] | None = None


class Transcript(CamelModel):
    segments: list[TranscriptSegment] = Field(default_factory=list)
    language: str | None = None
    durationMs: int | None = None
    speakers: list[TranscriptSpeakerInfo] | None = None


class TranscriptionProgressUpdate(CamelModel):
    stage: TranscriptionProgressStage
    percent: float
    message: str
    current: int | None = None
    total: int | None = None
    currentMs: int | None = None
    totalMs: int | None = None
    speaker: str | None = None
    stageRunId: str | None = None
    error: str | None = None


def coalesce_speaker_segments(
    segments: Sequence[TranscriptSegment | dict[str, Any]],
    max_gap_ms: int = 15000,
) -> list[TranscriptSegment]:
    """Merges consecutive segments from the same speaker if the silence gap between them is reasonable."""
    parsed = [
        s if isinstance(s, TranscriptSegment) else TranscriptSegment.model_validate(s) for s in segments
    ]
    if len(parsed) <= 1:
        return parsed

    merged: list[TranscriptSegment] = []
    current = TranscriptSegment(
        startMs=parsed[0].startMs,
        endMs=parsed[0].endMs,
        speaker=parsed[0].speaker,
        text=parsed[0].text,
        verified=parsed[0].verified,
        words=list(parsed[0].words) if parsed[0].words is not None else [],
    )

    for nxt in parsed[1:]:
        same_speaker = (current.speaker or "").strip().lower() == (nxt.speaker or "").strip().lower()
        gap_ms = nxt.startMs - current.endMs

        if same_speaker and (gap_ms <= max_gap_ms or not current.text.strip()):
            glue = " " if (current.text.strip() and nxt.text.strip()) else ""
            current.text = f"{current.text.strip()}{glue}{nxt.text.strip()}".strip()
            current.endMs = max(current.endMs, nxt.endMs)
            if nxt.words:
                current.words = [*(current.words or []), *nxt.words]
        else:
            if current.text.strip():
                merged.append(current)
            current = TranscriptSegment(
                startMs=nxt.startMs,
                endMs=nxt.endMs,
                speaker=nxt.speaker,
                text=nxt.text,
                verified=nxt.verified,
                words=list(nxt.words) if nxt.words is not None else [],
            )

    if current.text.strip():
        merged.append(current)

    return merged


class EnrolledSpeaker(CamelModel):
    id: str
    name: str
    providerIds: dict[str, list[str]] = Field(default_factory=dict)


class TranscriptionProviderCaps(CamelModel):
    diarization: bool
    speakerId: bool
    customVocab: bool


class LlmProviderConfig(CamelModel):
    apiKey: str | None = None
    baseUrl: str | None = None
    headers: dict[str, str] | None = None


class LlmCustomModel(CamelModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    provider: str = Field(min_length=1)
    api: str | None = None
    baseUrl: str | None = None
    contextWindow: int | None = Field(default=None, gt=0)
    maxTokens: int | None = Field(default=None, gt=0)
    reasoning: bool | None = None


class LlmSettings(CamelModel):
    defaultProvider: str = "google"
    defaultModel: str = "gemini-2.5-flash"
    defaultThinkingLevel: LlmThinkingLevel = "off"
    providers: dict[str, LlmProviderConfig] = Field(default_factory=dict)
    customModels: list[LlmCustomModel] = Field(default_factory=list)


class UpdateLlmSettingsInput(CamelModel):
    defaultProvider: str | None = None
    defaultModel: str | None = None
    defaultThinkingLevel: LlmThinkingLevel | None = None
    providers: dict[str, LlmProviderConfig] | None = None
    customModels: list[LlmCustomModel] | None = None


class LlmGenerateInput(CamelModel):
    provider: str | None = None
    model: str | None = None
    systemPrompt: str | None = None
    prompt: str = Field(min_length=1)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    maxTokens: int | None = Field(default=None, gt=0)
    thinkingLevel: LlmThinkingLevel | None = None
    apiKeyOverride: str | None = None
    baseUrlOverride: str | None = None


class LlmModelCost(CamelModel):
    input: float
    output: float
    cacheRead: float | None = None
    cacheWrite: float | None = None


class LlmModelCatalogItem(CamelModel):
    id: str
    name: str
    provider: str
    api: str
    baseUrl: str | None = None
    contextWindow: int | None = None
    maxTokens: int | None = None
    reasoning: bool | None = None
    supportedThinkingLevels: list[LlmThinkingLevel] | None = None
    cost: LlmModelCost | None = None
    source: Literal["builtin", "web", "custom"]


class LlmProviderSummary(CamelModel):
    id: str
    name: str
    isConfigured: bool
    hasCustomBaseUrl: bool
    modelCount: int


class LlmMessageInput(CamelModel):
    role: Literal["user", "assistant"]
    content: str
    timestamp: int | None = None


class LlmGenerateOptions(CamelModel):
    provider: str | None = None
    model: str | None = None
    systemPrompt: str | None = None
    prompt: str
    messages: list[LlmMessageInput] | None = None
    temperature: float | None = None
    maxTokens: int | None = None
    thinkingLevel: LlmThinkingLevel | None = None
    apiKeyOverride: str | None = None
    baseUrlOverride: str | None = None


class LlmGenerateResult(CamelModel):
    text: str
    provider: str
    model: str
    durationMs: int
    usage: ChatUsage


class MeetingSummaryItem(CamelModel):
    id: str
    provider: str
    format: ArtifactFormat
    path: str
    createdAt: int
    content: str
    isPrimary: bool


class SummaryGenerationStatus(CamelModel):
    meetingId: str
    stage: Literal["running", "done", "error"]
    startedAt: int
    provider: str | None = None
    model: str | None = None
    templateName: str | None = None
    artifactId: str | None = None
    error: str | None = None


class MeetingDetailAggregate(CamelModel):
    meeting: MeetingListItem
    recordings: list[Recording]
    artifacts: list[Artifact]
    speakers: list[Speaker]
    stageRuns: list[StageRunRow]
    transcriptContent: str | None = None
    summaryContent: str | None = None
    summaries: list[MeetingSummaryItem]
    transcriptionProgress: TranscriptionProgressUpdate | None = None
    summaryGeneration: SummaryGenerationStatus | None = None


class BackupManifestStats(CamelModel):
    meetingCount: int = Field(ge=0)
    recordingCount: int = Field(ge=0)
    audioFilesCount: int = Field(ge=0)
    totalAudioSizeBytes: int = Field(ge=0)
    summaryCount: int = Field(ge=0)
    speakerCount: int = Field(ge=0)
    templateCount: int = Field(ge=0)


class BackupManifest(CamelModel):
    version: str
    createdAt: str
    oliveVersion: str
    app: str
    stats: BackupManifestStats


class BackupInfo(CamelModel):
    filename: str
    sizeBytes: int = Field(ge=0)
    createdAt: str
    manifest: BackupManifest | None = None


class RestoreStats(CamelModel):
    meetings: int = Field(ge=0)
    recordings: int = Field(ge=0)
    audioFiles: int = Field(ge=0)
    summaries: int = Field(ge=0)
    speakers: int = Field(ge=0)
    templates: int = Field(ge=0)


class RestoreResult(CamelModel):
    success: bool
    restoredAt: str
    manifest: BackupManifest | None = None
    stats: RestoreStats


class LogItem(CamelModel):
    id: str
    level: LogLevel
    category: str
    message: str
    meetingId: str | None = None
    meetingTitle: str | None = None
    details: dict[str, Any] | None = None
    createdAt: int


class LogPagination(CamelModel):
    total: int
    limit: int
    offset: int


class LogListResponse(CamelModel):
    logs: list[LogItem]
    pagination: LogPagination
    categories: list[str]


UsageKind = Literal["transcription", "summary", "chat"]


class UsageEvent(CamelModel):
    id: str
    meetingId: str | None = None
    meetingTitle: str | None = None
    kind: UsageKind
    provider: str
    model: str | None = None
    inputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    audioSeconds: float | None = None
    costUsd: float | None = None
    createdAt: int


class UsageProviderBreakdown(CamelModel):
    provider: str
    kinds: list[UsageKind] = Field(default_factory=list)
    audioSeconds: float = 0
    inputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    eventCount: int = 0
    costUsd: float = 0


class UsageMeetingBreakdown(CamelModel):
    meetingId: str
    meetingTitle: str | None = None
    meetingStartTime: int | None = None
    audioSeconds: float = 0
    transcriptionCostUsd: float = 0
    inputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    llmCostUsd: float = 0
    totalCostUsd: float = 0
    eventCount: int = 0


class UsageRates(CamelModel):
    transcriptionUsdPerHour: dict[str, float] = Field(default_factory=dict)
    llmUsdPerMTokensNote: str = "Per-model input/output rates per 1M tokens from the LLM catalog."


class UsageSummary(CamelModel):
    startAt: int | None = None
    endAt: int | None = None
    audioSeconds: float = 0
    transcriptionCostUsd: float = 0
    inputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    llmCostUsd: float = 0
    totalCostUsd: float = 0
    eventCount: int = 0
    byProvider: list[UsageProviderBreakdown] = Field(default_factory=list)
    byMeeting: list[UsageMeetingBreakdown] = Field(default_factory=list)
    rates: UsageRates | None = None


class MeetingUsageResponse(CamelModel):
    meetingId: str
    audioSeconds: float = 0
    transcriptionCostUsd: float = 0
    inputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    llmCostUsd: float = 0
    totalCostUsd: float = 0
    eventCount: int = 0
    events: list[UsageEvent] = Field(default_factory=list)
