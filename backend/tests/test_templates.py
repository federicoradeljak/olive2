"""Templates service and API tests (port of templates.test.ts)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from olive.app import create_app
from olive.db import create_db
from olive.services.templates import TemplateService


async def test_seeds_builtin_templates_with_executive_summary_default() -> None:
    handle = create_db(":memory:")
    service = TemplateService(handle.engine)

    templates = await service.list_templates()
    assert len(templates) == 4

    default_tpl = await service.get_default_template()
    assert default_tpl is not None
    assert default_tpl.name == "Executive Summary"
    assert default_tpl.isDefault is True
    assert default_tpl.isBuiltin is True
    handle.engine.dispose()


async def test_creates_custom_template_and_manages_default_status() -> None:
    handle = create_db(":memory:")
    service = TemplateService(handle.engine)

    custom = await service.create_template(
        {
            "name": "Retrospective",
            "description": "Sprint retro notes",
            "systemPrompt": "You are an agile facilitator.",
            "userPrompt": "# Retro: {{title}}\n\n## What went well\n\n{{transcript}}",
            "isDefault": True,
        }
    )
    assert custom.id
    assert custom.name == "Retrospective"
    assert custom.isDefault is True
    assert custom.isBuiltin is False

    all_tpls = await service.list_templates()
    exec_summary = next(t for t in all_tpls if t.name == "Executive Summary")
    assert exec_summary.isDefault is False

    current_default = await service.get_default_template()
    assert current_default is not None
    assert current_default.id == custom.id
    handle.engine.dispose()


async def test_updates_custom_template_and_prevents_deleting_builtin() -> None:
    handle = create_db(":memory:")
    service = TemplateService(handle.engine)

    created = await service.create_template(
        {
            "name": "Draft Template",
            "userPrompt": "Initial prompt {{transcript}}",
        }
    )
    updated = await service.update_template(
        created.id,
        {
            "name": "Refined Template",
            "description": "Updated description",
            "userPrompt": "New prompt: {{transcript}}",
        },
    )
    assert updated.name == "Refined Template"
    assert updated.description == "Updated description"
    assert updated.userPrompt == "New prompt: {{transcript}}"

    builtins = await service.list_templates()
    with pytest.raises(ValueError, match="Cannot delete built-in templates"):
        await service.delete_template(builtins[0].id)

    await service.delete_template(created.id)
    assert await service.get_template(created.id) is None
    handle.engine.dispose()


def test_templates_api_crud() -> None:
    handle = create_db(":memory:")
    app = create_app({"db": handle.engine})
    client = TestClient(app)

    list_res = client.get("/api/templates")
    assert list_res.status_code == 200
    templates = list_res.json()["templates"]
    assert len(templates) == 4

    first_id = templates[0]["id"]
    get_res = client.get(f"/api/templates/{first_id}")
    assert get_res.status_code == 200
    assert get_res.json()["template"]["id"] == first_id

    create_res = client.post(
        "/api/templates",
        json={
            "name": "Standup Notes",
            "description": "Daily standup summary",
            "systemPrompt": "Summarize daily standup.",
            "userPrompt": "Standup: {{transcript}}",
        },
    )
    assert create_res.status_code == 201
    template_id = create_res.json()["template"]["id"]

    patch_res = client.patch(
        f"/api/templates/{template_id}",
        json={"description": "Updated standup description"},
    )
    assert patch_res.status_code == 200
    assert patch_res.json()["template"]["description"] == "Updated standup description"

    default_res = client.post(f"/api/templates/{template_id}/default")
    assert default_res.status_code == 200
    assert default_res.json()["template"]["isDefault"] is True

    del_res = client.delete(f"/api/templates/{template_id}")
    assert del_res.status_code == 200

    verify_res = client.get(f"/api/templates/{template_id}")
    assert verify_res.status_code == 404
    handle.engine.dispose()
