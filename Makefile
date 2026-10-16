.PHONY: test-smoke test-backend test-integration test-frontend test-all build-frontend check

# Run API smoke tests (standalone mode, no data files needed)
test-smoke:
	python -m pytest tests/test_api_smoke.py -v --tb=short

# Run all backend tests (excluding integration tests requiring real data)
test-backend:
	python -m pytest tests/ -v --tb=short -m "not integration"

# Run integration tests on the lab's Drosophila data. Point
# FIBERBROWSER_TEST_DATA_DIR at a directory with the fly_lab_data layout
# (or its parent); without it every integration test skips and says so.
test-integration:
	@test -n "$$FIBERBROWSER_TEST_DATA_DIR" || echo "FIBERBROWSER_TEST_DATA_DIR is not set: the integration tests will skip"
	python -m pytest tests/ -v --tb=short -m integration -rs

# Run frontend store tests
test-frontend:
	cd browser/frontend && npm run test:run

# Run all tests (backend + frontend, excluding integration)
test-all: test-backend test-frontend

# Build frontend
build-frontend:
	cd browser/frontend && npm run build

# Full verification: backend tests + frontend tests + frontend build
check: test-backend test-frontend build-frontend
	@echo "All checks passed."
