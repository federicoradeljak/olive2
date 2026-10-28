"""Modal.com GPU worker provider package."""

from .audio import prepare_modal_flac
from .client import DEFAULT_APP_NAME, DEFAULT_CLASS_NAME, ModalCancelledError, ModalClient
from .types import ModalTimings, ModalTranscribeResult

__all__ = [
    "DEFAULT_APP_NAME",
    "DEFAULT_CLASS_NAME",
    "ModalCancelledError",
    "ModalClient",
    "ModalTimings",
    "ModalTranscribeResult",
    "prepare_modal_flac",
]
