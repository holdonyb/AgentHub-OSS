from __future__ import annotations

import base64
import hashlib
import hmac

from cryptography.fernet import Fernet

from app.core.config import Settings


def _key_material(settings: Settings) -> str:
    return (
        settings.secret_encryption_key.strip()
        or (settings.bootstrap_token or "").strip()
        or (settings.worker_registration_token or "").strip()
        or f"{settings.app_name}:development-secret-key"
    )


def _fernet(settings: Settings) -> Fernet:
    digest = hashlib.sha256(_key_material(settings).encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret_value(value: str, settings: Settings) -> str:
    return _fernet(settings).encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret_value(value_ciphertext: str, settings: Settings) -> str:
    return _fernet(settings).decrypt(value_ciphertext.encode("ascii")).decode("utf-8")


def secret_value_hash(value: str, settings: Settings) -> str:
    return hmac.new(_key_material(settings).encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()
