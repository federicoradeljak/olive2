"""Olive local ML pipeline package."""

from ..schemas import coalesce_speaker_segments
from .align import CtcForcedAligner, proportional_word_timestamps
from .asr_cohere import CohereAsrEngine, MockLocalAsrEngine, TransformersAsrEngine
from .audio import (
    SPEECH_ENHANCEMENT_FILTER,
    DecodedWav,
    decode_wav,
    encode_wav,
    enhance_audio_file,
    enhance_audio_file_async,
    is_wav,
    load_audio_samples,
    resample,
)
from .diarize import LocalSpeakerDiarizer, PyannoteSpeakerDiarizer, SherpaSpeakerDiarizer
from .embed import (
    WESPEAKER_FILENAME,
    WESPEAKER_MODEL_TAG,
    WESPEAKER_REPO_ID,
    AcousticFeatureEmbeddingExtractor,
    SherpaSpeakerEmbeddingExtractor,
    WeSpeakerEmbeddingExtractor,
)
from .identify import (
    identify_cloud_transcript_speakers,
    identify_speakers_from_turns,
    match_cluster_centroids,
    rename_transcript_speakers,
    turns_from_transcript,
)
from .pipeline import LocalTranscriptionPipeline
from .protocols import (
    Aligner,
    AsrBackend,
    Diarizer,
    DiarizerInterface,
    DiscoveredSpeakerVoiceprint,
    LocalAsrEngineInterface,
    LocalSpeakerSegment,
    LocalTranscriptionResult,
    SpeakerEmbedder,
    SpeakerEmbeddingExtractorInterface,
    VoiceprintVector,
)
from .scoring import (
    cosine_similarity,
    cosineSimilarity,
    l2_norm,
    l2Norm,
    merge_voiceprint_vectors,
    merge_weighted_voiceprint_vectors,
    mergeVoiceprintVectors,
    mergeWeightedVoiceprintVectors,
    normalize_vector,
    normalizeVector,
    score_against_trusted_vectors,
    scoreAgainstTrustedVectors,
    update_voiceprint_centroid,
    updateVoiceprintCentroid,
)
from .worker import AbortController, AbortSignal, LocalTranscriptionWorkerRunner

decodeWav = decode_wav
encodeWav = encode_wav
isWav = is_wav
loadAudioSamples = load_audio_samples
enhanceAudioFile = enhance_audio_file
enhanceAudioFileAsync = enhance_audio_file_async
coalesceSpeakerSegments = coalesce_speaker_segments

__all__ = [
    "AbortController",
    "identify_cloud_transcript_speakers",
    "identify_speakers_from_turns",
    "match_cluster_centroids",
    "rename_transcript_speakers",
    "turns_from_transcript",
    "AbortSignal",
    "AcousticFeatureEmbeddingExtractor",
    "Aligner",
    "AsrBackend",
    "CohereAsrEngine",
    "CtcForcedAligner",
    "DecodedWav",
    "Diarizer",
    "DiarizerInterface",
    "DiscoveredSpeakerVoiceprint",
    "LocalAsrEngineInterface",
    "LocalSpeakerDiarizer",
    "LocalSpeakerSegment",
    "LocalTranscriptionPipeline",
    "LocalTranscriptionResult",
    "LocalTranscriptionWorkerRunner",
    "MockLocalAsrEngine",
    "PyannoteSpeakerDiarizer",
    "SPEECH_ENHANCEMENT_FILTER",
    "SherpaSpeakerDiarizer",
    "SherpaSpeakerEmbeddingExtractor",
    "SpeakerEmbedder",
    "SpeakerEmbeddingExtractorInterface",
    "TransformersAsrEngine",
    "VoiceprintVector",
    "WESPEAKER_FILENAME",
    "WESPEAKER_MODEL_TAG",
    "WESPEAKER_REPO_ID",
    "WeSpeakerEmbeddingExtractor",
    "coalesceSpeakerSegments",
    "coalesce_speaker_segments",
    "cosineSimilarity",
    "cosine_similarity",
    "decodeWav",
    "decode_wav",
    "encodeWav",
    "encode_wav",
    "enhanceAudioFile",
    "enhanceAudioFileAsync",
    "enhance_audio_file",
    "enhance_audio_file_async",
    "isWav",
    "is_wav",
    "l2Norm",
    "l2_norm",
    "loadAudioSamples",
    "load_audio_samples",
    "mergeVoiceprintVectors",
    "mergeWeightedVoiceprintVectors",
    "merge_voiceprint_vectors",
    "merge_weighted_voiceprint_vectors",
    "normalizeVector",
    "normalize_vector",
    "proportional_word_timestamps",
    "resample",
    "scoreAgainstTrustedVectors",
    "score_against_trusted_vectors",
    "updateVoiceprintCentroid",
    "update_voiceprint_centroid",
]
