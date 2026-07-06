"""Budżet module: CRUD for recurring income/expenses and loans."""
import pytest
from fastapi.testclient import TestClient

import web.server as server


@pytest.fixture()
def client():
    return TestClient(server.app)


# ---- Items (income / expenses) ----------------------------------------------

def _cat(client, kind="EXPENSE"):
    return next(c["id"] for c in client.get("/api/budget/categories").json() if c["kind"] == kind)


def test_item_crud(client):
    cid = _cat(client)
    r = client.post("/api/budget/items", json={
        "type": "EXPENSE", "name": "Prąd", "amount": 250, "category_id": cid,
    })
    assert r.status_code == 201
    iid = r.json()["id"]

    got = client.get("/api/budget/items?type=EXPENSE").json()
    row = next(x for x in got if x["id"] == iid)
    assert (row["name"], row["amount"], row["category_id"], row["month"]) == ("Prąd", 250, cid, None)

    r = client.put(f"/api/budget/items/{iid}", json={
        "name": "Prąd i gaz", "amount": 370, "category_id": cid, "note": "łącznie",
    })
    assert r.status_code == 200
    row = next(x for x in client.get("/api/budget/items").json() if x["id"] == iid)
    assert (row["name"], row["amount"], row["note"]) == ("Prąd i gaz", 370, "łącznie")

    assert client.delete(f"/api/budget/items/{iid}").status_code == 200
    assert all(x["id"] != iid for x in client.get("/api/budget/items").json())


def test_one_off_item_has_month(client):
    r = client.post("/api/budget/items", json={
        "type": "EXPENSE", "name": "Ubezpieczenie auta", "amount": 1200,
        "category_id": _cat(client), "month": "2026-09",
    })
    iid = r.json()["id"]
    row = next(x for x in client.get("/api/budget/items").json() if x["id"] == iid)
    assert row["month"] == "2026-09"


def test_item_type_filter(client):
    client.post("/api/budget/items", json={"type": "INCOME", "name": "Wypłata", "amount": 8000})
    client.post("/api/budget/items", json={"type": "EXPENSE", "name": "Internet", "amount": 90})
    incomes = client.get("/api/budget/items?type=INCOME").json()
    assert all(x["type"] == "INCOME" for x in incomes)
    assert any(x["name"] == "Wypłata" for x in incomes)


def test_item_validation(client):
    assert client.post("/api/budget/items", json={"type": "SAVINGS", "name": "x", "amount": 1}).status_code == 422
    assert client.post("/api/budget/items", json={"type": "EXPENSE", "name": "", "amount": 1}).status_code == 422
    assert client.post("/api/budget/items", json={"type": "EXPENSE", "name": "x", "amount": -5}).status_code == 422
    assert client.post("/api/budget/items", json={"type": "EXPENSE", "name": "x", "amount": 1, "month": "2026/09"}).status_code == 422


def test_update_missing_item_404(client):
    assert client.put("/api/budget/items/999999", json={"name": "x", "amount": 1}).status_code == 404
    assert client.delete("/api/budget/items/999999").status_code == 404


# ---- Categories -------------------------------------------------------------

def test_default_categories_seeded(client):
    cats = client.get("/api/budget/categories").json()
    assert any(c["kind"] == "EXPENSE" for c in cats)
    assert any(c["kind"] == "INCOME" for c in cats)
    # all colours are valid hex
    assert all(len(c["color"]) == 7 and c["color"][0] == "#" for c in cats)


def test_category_crud_and_delete_nulls_items(client):
    r = client.post("/api/budget/categories", json={"kind": "EXPENSE", "name": "Zwierzęta", "color": "#ff8800"})
    assert r.status_code == 201
    cid = r.json()["id"]

    r = client.put(f"/api/budget/categories/{cid}", json={"name": "Pupile", "color": "#aa22cc"})
    assert r.status_code == 200
    row = next(c for c in client.get("/api/budget/categories").json() if c["id"] == cid)
    assert (row["name"], row["color"]) == ("Pupile", "#aa22cc")

    # an item using the category loses it (not blocked) when the category goes
    iid = client.post("/api/budget/items", json={
        "type": "EXPENSE", "name": "Karma", "amount": 120, "category_id": cid,
    }).json()["id"]
    assert client.delete(f"/api/budget/categories/{cid}").status_code == 200
    row = next(x for x in client.get("/api/budget/items").json() if x["id"] == iid)
    assert row["category_id"] is None


def test_category_validation(client):
    assert client.post("/api/budget/categories", json={"kind": "EXPENSE", "name": "X", "color": "red"}).status_code == 422
    assert client.post("/api/budget/categories", json={"kind": "SAVE", "name": "X", "color": "#fff000"}).status_code == 422
    assert client.post("/api/budget/categories", json={"kind": "EXPENSE", "name": "", "color": "#fff000"}).status_code == 422


# ---- Loans ------------------------------------------------------------------

def test_loan_crud(client):
    r = client.post("/api/budget/loans", json={
        "name": "Samochód", "principal": 60000, "remaining": 42000,
        "installment": 1200, "end_month": "2028-12",
    })
    assert r.status_code == 201, r.text
    lid = r.json()["id"]

    row = next(x for x in client.get("/api/budget/loans").json() if x["id"] == lid)
    assert (row["installment"], row["remaining"], row["end_month"]) == (1200, 42000, "2028-12")

    # overpayment + rate change: just edit the current state
    r = client.put(f"/api/budget/loans/{lid}", json={
        "name": "Samochód", "principal": 60000, "remaining": 35000,
        "installment": 1250, "end_month": "2028-06", "note": "nadpłata",
    })
    assert r.status_code == 200
    row = next(x for x in client.get("/api/budget/loans").json() if x["id"] == lid)
    assert (row["remaining"], row["installment"], row["end_month"]) == (35000, 1250, "2028-06")

    assert client.delete(f"/api/budget/loans/{lid}").status_code == 200
    assert all(x["id"] != lid for x in client.get("/api/budget/loans").json())


def test_loan_validation(client):
    base = {"name": "L", "installment": 100, "remaining": 500, "end_month": "2027-01"}
    assert client.post("/api/budget/loans", json={**base, "end_month": "2027/01"}).status_code == 422
    assert client.post("/api/budget/loans", json={**base, "installment": 0}).status_code == 422
    assert client.post("/api/budget/loans", json={**base, "remaining": -5}).status_code == 422
    assert client.post("/api/budget/loans", json={**base, "end_month": "styczeń"}).status_code == 422


# ---- Cost splitting (partner's share) ---------------------------------------

def test_item_shared_amount(client):
    r = client.post("/api/budget/items", json={
        "type": "EXPENSE", "name": "Czynsz", "amount": 3500, "shared_amount": 1500,
    })
    assert r.status_code == 201
    iid = r.json()["id"]
    row = next(x for x in client.get("/api/budget/items").json() if x["id"] == iid)
    assert row["shared_amount"] == 1500


def test_shared_cannot_exceed_amount(client):
    assert client.post("/api/budget/items", json={
        "type": "EXPENSE", "name": "X", "amount": 100, "shared_amount": 150,
    }).status_code == 422


def test_loan_shared_installment(client):
    r = client.post("/api/budget/loans", json={
        "name": "Wspólny kredyt", "principal": 210000, "remaining": 180000,
        "installment": 3500, "end_month": "2030-01", "shared_installment": 1500,
    })
    assert r.status_code == 201
    lid = r.json()["id"]
    row = next(x for x in client.get("/api/budget/loans").json() if x["id"] == lid)
    assert row["shared_installment"] == 1500

    # shared > installment rejected
    assert client.post("/api/budget/loans", json={
        "name": "Y", "installment": 500, "remaining": 6000,
        "end_month": "2027-01", "shared_installment": 600,
    }).status_code == 422


# ---- Per-month income amounts -----------------------------------------------

def test_income_amount_per_month(client):
    iid = client.post("/api/budget/items", json={"type": "INCOME", "name": "Wypłata", "amount": 0}).json()["id"]
    # no amount yet → absent
    assert str(iid) not in client.get("/api/budget/income-amounts?month=2026-07").json()

    client.put("/api/budget/income-amounts", json={"item_id": iid, "month": "2026-07", "amount": 8200})
    client.put("/api/budget/income-amounts", json={"item_id": iid, "month": "2026-08", "amount": 7900})
    assert client.get("/api/budget/income-amounts?month=2026-07").json()[str(iid)] == 8200
    assert client.get("/api/budget/income-amounts?month=2026-08").json()[str(iid)] == 7900
    # a fresh month has no amount → zeroed
    assert str(iid) not in client.get("/api/budget/income-amounts?month=2026-09").json()

    # upsert overwrites
    client.put("/api/budget/income-amounts", json={"item_id": iid, "month": "2026-07", "amount": 8500})
    assert client.get("/api/budget/income-amounts?month=2026-07").json()[str(iid)] == 8500

    # deleting the source removes its amounts (no FK error)
    assert client.delete(f"/api/budget/items/{iid}").status_code == 200
    assert client.get("/api/budget/income-amounts?month=2026-07").json() == {}


def test_income_amount_validation(client):
    assert client.get("/api/budget/income-amounts?month=2026/07").status_code == 422
    assert client.put("/api/budget/income-amounts", json={"item_id": 1, "month": "bad", "amount": 10}).status_code == 422
    assert client.put("/api/budget/income-amounts", json={"item_id": 1, "month": "2026-07", "amount": -5}).status_code == 422
