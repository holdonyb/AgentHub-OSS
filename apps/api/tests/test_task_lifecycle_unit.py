from __future__ import annotations

from app.task_lifecycle import report_artifact_content


def test_report_artifact_content_strips_only_anchored_session_marker() -> None:
    assert report_artifact_content(
        "created_session_id=task-session\n# Delivery\n\nTests pass."
    ) == "# Delivery\n\nTests pass."
    assert report_artifact_content(
        "# Delivery\ncreated_session_id=not-a-marker"
    ) == "# Delivery\ncreated_session_id=not-a-marker"
