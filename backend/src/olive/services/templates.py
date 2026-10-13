"""Summary prompt template service (port of packages/server/src/templates/service.ts)."""

from __future__ import annotations

import time
import uuid
from collections.abc import Mapping
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from ..db import get_db
from ..logging_db import logger
from ..schemas import CreateTemplateInput, Template, UpdateTemplateInput


def _map_template_row(row: Mapping[Any, Any]) -> Template:
    return Template(
        id=row["id"],
        name=row["name"],
        description=row.get("description"),
        systemPrompt=row["system_prompt"],
        userPrompt=row["user_prompt"],
        isDefault=int(row["is_default"]) == 1,
        isBuiltin=int(row["is_builtin"]) == 1,
        createdAt=int(row["created_at"]),
        updatedAt=int(row["updated_at"]),
    )


class TemplateService:
    def __init__(self, db: Engine | None = None) -> None:
        self.db = db or get_db()

    async def list_templates(self) -> list[Template]:
        with self.db.connect() as conn:
            rows = conn.execute(
                text(
                    "SELECT * FROM templates "
                    "ORDER BY is_default DESC, is_builtin DESC, name ASC"
                )
            ).mappings().all()
        return [_map_template_row(r) for r in rows]

    async def get_template(self, template_id: str) -> Template | None:
        with self.db.connect() as conn:
            row = conn.execute(
                text("SELECT * FROM templates WHERE id = :id"),
                {"id": template_id},
            ).mappings().first()
        return _map_template_row(row) if row else None

    async def get_default_template(self) -> Template | None:
        with self.db.connect() as conn:
            default_row = conn.execute(
                text("SELECT * FROM templates WHERE is_default = 1 LIMIT 1")
            ).mappings().first()
            if default_row:
                return _map_template_row(default_row)

            first_builtin = conn.execute(
                text("SELECT * FROM templates WHERE is_builtin = 1 ORDER BY name ASC LIMIT 1")
            ).mappings().first()
            return _map_template_row(first_builtin) if first_builtin else None

    async def create_template(self, raw_input: dict[str, Any] | CreateTemplateInput) -> Template:
        inp = (
            raw_input
            if isinstance(raw_input, CreateTemplateInput)
            else CreateTemplateInput.model_validate(raw_input)
        )
        now = int(time.time() * 1000)
        template_id = str(uuid.uuid4())

        with self.db.begin() as conn:
            if inp.isDefault:
                conn.execute(
                    text("UPDATE templates SET is_default = 0, updated_at = :now"),
                    {"now": now},
                )
            conn.execute(
                text(
                    """
                    INSERT INTO templates (
                      id, name, description, system_prompt, user_prompt,
                      is_default, is_builtin, created_at, updated_at
                    ) VALUES (
                      :id, :name, :description, :system_prompt, :user_prompt,
                      :is_default, 0, :created_at, :updated_at
                    )
                    """
                ),
                {
                    "id": template_id,
                    "name": inp.name,
                    "description": inp.description,
                    "system_prompt": inp.systemPrompt or "",
                    "user_prompt": inp.userPrompt,
                    "is_default": 1 if inp.isDefault else 0,
                    "created_at": now,
                    "updated_at": now,
                },
            )

        logger.info(
            "Created custom summary template",
            {"id": template_id, "name": inp.name, "isDefault": inp.isDefault},
        )
        created = await self.get_template(template_id)
        if not created:
            raise RuntimeError(f"Failed to retrieve newly created template {template_id}")
        return created

    async def update_template(
        self, template_id: str, raw_input: dict[str, Any] | UpdateTemplateInput
    ) -> Template:
        raw_dict = (
            raw_input.model_dump(exclude_unset=True)
            if isinstance(raw_input, UpdateTemplateInput)
            else dict(raw_input)
        )
        inp = UpdateTemplateInput.model_validate(raw_dict)
        existing = await self.get_template(template_id)
        if not existing:
            raise ValueError(f"Template not found: {template_id}")

        now = int(time.time() * 1000)
        sets = ["updated_at = :updated_at"]
        params: dict[str, Any] = {"id": template_id, "updated_at": now}

        if "name" in raw_dict and inp.name is not None:
            sets.append("name = :name")
            params["name"] = inp.name
        if "description" in raw_dict:
            sets.append("description = :description")
            params["description"] = inp.description
        if "systemPrompt" in raw_dict and inp.systemPrompt is not None:
            sets.append("system_prompt = :system_prompt")
            params["system_prompt"] = inp.systemPrompt
        if "userPrompt" in raw_dict and inp.userPrompt is not None:
            sets.append("user_prompt = :user_prompt")
            params["user_prompt"] = inp.userPrompt
        if "isDefault" in raw_dict and inp.isDefault is not None:
            sets.append("is_default = :is_default")
            params["is_default"] = 1 if inp.isDefault else 0

        with self.db.begin() as conn:
            if inp.isDefault:
                conn.execute(
                    text("UPDATE templates SET is_default = 0, updated_at = :now WHERE id != :id"),
                    {"now": now, "id": template_id},
                )
            conn.execute(
                text(f"UPDATE templates SET {', '.join(sets)} WHERE id = :id"),
                params,
            )

        logger.info("Updated summary template", {"id": template_id, "name": inp.name or existing.name})
        updated = await self.get_template(template_id)
        if not updated:
            raise RuntimeError(f"Failed to retrieve updated template {template_id}")
        return updated

    async def delete_template(self, template_id: str) -> None:
        existing = await self.get_template(template_id)
        if not existing:
            raise ValueError(f"Template not found: {template_id}")
        if existing.isBuiltin:
            raise ValueError("Cannot delete built-in templates")

        now = int(time.time() * 1000)
        with self.db.begin() as conn:
            conn.execute(text("DELETE FROM templates WHERE id = :id"), {"id": template_id})
            if existing.isDefault:
                fallback = conn.execute(
                    text("SELECT * FROM templates WHERE is_builtin = 1 ORDER BY name ASC LIMIT 1")
                ).mappings().first()
                if fallback:
                    conn.execute(
                        text("UPDATE templates SET is_default = 1, updated_at = :now WHERE id = :id"),
                        {"now": now, "id": fallback["id"]},
                    )

        logger.info("Deleted summary template", {"id": template_id, "name": existing.name})

    async def set_default_template(self, template_id: str) -> Template:
        existing = await self.get_template(template_id)
        if not existing:
            raise ValueError(f"Template not found: {template_id}")

        now = int(time.time() * 1000)
        with self.db.begin() as conn:
            conn.execute(
                text("UPDATE templates SET is_default = 0, updated_at = :now"),
                {"now": now},
            )
            conn.execute(
                text("UPDATE templates SET is_default = 1, updated_at = :now WHERE id = :id"),
                {"now": now, "id": template_id},
            )

        logger.info("Set default summary template", {"id": template_id, "name": existing.name})
        updated = await self.get_template(template_id)
        assert updated is not None
        return updated
