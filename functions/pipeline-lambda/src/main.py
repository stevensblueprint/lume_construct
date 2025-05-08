from typing import Dict, Any
import logging
import requests
from pathlib import Path
import os

from .config import load_yaml_config

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_BASE_DIR = Path(__file__).parent
CONFIG_PATH = Path(os.environ.get("CONFIG_PATH", _BASE_DIR / "config.yaml"))
PIPELINE_WEBHOOKS = load_yaml_config(CONFIG_PATH)

STATE_COLORS = {
    "SUCCEEDED": 0x2ECC71,  # green
    "FAILED": 0xE74C3C,  # red
    "STARTED": 0x3498DB,  # blue
    "STOPPING": 0xF39C12,  # orange
}


def handler(event: Dict, _context: Any) -> Dict[str, Any]:
    detail = event.get("detail", {})
    pipeline_name = detail.get("pipeline", "")
    state = detail.get("state", "")

    if not pipeline_name or not state:
        logger.error("Missing pipeline name or status in event.")
        return {"status": "error", "message": "Missing pipeline name or status."}

    webhook_cfg = PIPELINE_WEBHOOKS.get(pipeline_name)
    if not webhook_cfg:
        logger.error(f"No webhook configuration found for pipeline: {pipeline_name}")
        return {
            "status": "error",
            "message": f"No webhook configuration found for pipeline: {pipeline_name}",
        }
    url = webhook_cfg.get("url")
    method = webhook_cfg.get("method", "POST").upper()
    headers = webhook_cfg.get("headers", {"Content-Type": "application/json"})

    trigger = detail.get("execution-trigger", {})
    author = trigger.get("author-display-name") or trigger.get("author-id", "Unknown")
    commit_id = trigger.get("commit-id", "N/A")
    commit_message = trigger.get("commit-message", "N/A")
    pipeline_url = webhook_cfg.get("pipelineUrl", "")
    payload = {
        "username": "AWS Pipelines",
        "content": f"Pipeline **{pipeline_name}** status changed to **{state}**",
        "embeds": [
            {
                "title": pipeline_name,
                "description": f"State: **{state}**",
                "color": STATE_COLORS.get(state, 0x95A5A6),
                "fields": [
                    {"name": "Author", "value": author, "inline": True},
                    {"name": "Commit ID", "value": commit_id, "inline": True},
                    {
                        "name": "Commit Message",
                        "value": commit_message,
                        "inline": False,
                    },
                    {
                        "name": "Pipeline Link",
                        "value": f"[View Pipeline]({pipeline_url})",
                        "inline": False,
                    },
                ],
                "timestamp": event.get("time"),
            }
        ],
    }
    try:
        resp = requests.request(method, url, headers=headers, json=payload)
        resp.raise_for_status()
        logger.info("Sent webhook for %s → %s", pipeline_name, state)
        return {"status": "sent"}
    except requests.exceptions.HTTPError as e:
        logger.error("Error sending webhook: %s", e)
        raise
