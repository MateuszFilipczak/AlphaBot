"""Budżet module: CRUD for recurring income/expenses and loans."""
import pytest
from fastapi.testclient import TestClient

import web.server as server


@pytest.fixture()
def client():
    return TestClient(server.app)


# ---- Items (income / expenses) ----------------------------------------------

def test_item_crud(client):
    r = client.post("/api/budget/items", json={
        "type": "EXPENSE", "name": "Prąd", "amount": 250, "category": "media",
    })
    assert r.status_code == 201
    iid = r.json()["id"]

    got = client.get("/api/budget/items?type=EXPENSE").json()
    row = next(x for x in got if x["id"] == iid)
    assert (row["name"], row["amount"], row["category"]) == ("Prąd", 250, "media")

    r = client.put(f"/api/budget/items/{iid}", json={
        "name": "Prąd i gaz", "amount": 370, "category": "media", "note": "łącznie",
    })
    assert r.status_code == 200
    row = next(x for x in client.get("/api/budget/items").json() if x["id"] == iid)
    assert (row["name"], row["amount"], row["note"]) == ("Prąd i gaz", 370, "łącznie")

    assert client.delete(f"/api/budget/items/{iid}").status_code == 200
    assert all(x["id"] != iid for x in client.get("/api/budget/items").json())


def test_item_type_filter(client):
    client.post("/api/budget/items", json={"type": "INCOME", "name": "Wypłata", "amount": 8000, "category": "wyplata"})
    client.post("/api/budget/items", json={"type": "EXPENSE", "name": "Internet", "amount": 90, "category": "media"})
    incomes = client.get("/api/budget/items?type=INCOME").json()
    assert all(x["type"] == "INCOME" for x in incomes)
    assert any(x["name"] == "Wypłata" for x in incomes)


def test_item_validation(client):
    assert client.post("/api/budget/items", json={"type": "SAVINGS", "name": "x", "amount": 1}).status_code == 422
    assert client.post("/api/budget/items", json={"type": "EXPENSE", "name": "", "amount": 1}).status_code == 422
    assert client.post("/api/budget/items", json={"type": "EXPENSE", "name": "x", "amount": -5}).status_code == 422


def test_update_missing_item_404(client):
    assert client.put("/api/budget/items/999999", json={"name": "x", "amount": 1, "category": "inne"}).status_code == 404
    assert client.delete("/api/budget/items/999999").status_code == 404


# ---- Loans ------------------------------------------------------------------

def test_loan_crud(client):
    r = client.post("/api/budget/loans", json={
        "name": "Samochód", "principal": 60000, "installment": 1200,
        "installments_count": 48, "start_month": "2024-01",
    })
    assert r.status_code == 201, r.text
    lid = r.json()["id"]

    row = next(x for x in client.get("/api/budget/loans").json() if x["id"] == lid)
    assert (row["installment"], row["installments_count"], row["start_month"]) == (1200, 48, "2024-01")

    r = client.put(f"/api/budget/loans/{lid}", json={
        "name": "Samochód", "principal": 60000, "installment": 1250,
        "installments_count": 48, "start_month": "2024-01", "note": "podwyżka raty",
    })
    assert r.status_code == 200
    row = next(x for x in client.get("/api/budget/loans").json() if x["id"] == lid)
    assert row["installment"] == 1250 and row["note"] == "podwyżka raty"

    assert client.delete(f"/api/budget/loans/{lid}").status_code == 200
    assert all(x["id"] != lid for x in client.get("/api/budget/loans").json())


def test_loan_validation(client):
    base = {"name": "L", "installment": 100, "installments_count": 12, "start_month": "2025-01"}
    assert client.post("/api/budget/loans", json={**base, "start_month": "2025/01"}).status_code == 422
    assert client.post("/api/budget/loans", json={**base, "installment": 0}).status_code == 422
    assert client.post("/api/budget/loans", json={**base, "installments_count": 0}).status_code == 422
    assert client.post("/api/budget/loans", json={**base, "start_month": "styczeń"}).status_code == 422
