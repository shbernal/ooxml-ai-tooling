# The shipped core: the implementation modules and the built database they query.
# Every one is copied byte-identically into both surfaces. The tests and
# everything under build/ are deliberately absent — they are development-only and
# must never reach a surface.
#
# Filled in as core/ grows; `check-vendor` is a no-op while this list is empty.
CORE_FILES :=

VENDOR_DIRS := skill/scripts mcp/src

.PHONY: db sync-core check-vendor test verify smoke help

help:
	@echo "db            build core/data/ooxml.db from schemas/"
	@echo "sync-core     copy the core modules and database into both surfaces"
	@echo "check-vendor  verify the vendored copies match"
	@echo "test          run the core suite"
	@echo "verify        lint + test, the same gate CI runs"
	@echo "smoke         drive the MCP server over real stdio JSON-RPC"

# The database is build output, not source: core/data/ooxml.db is gitignored and
# rebuilt from the committed XSDs. The two *committed* copies live in the
# surfaces (see sync-core), because each is distributed on its own.
db:
	node build/ingest.mjs

sync-core:
	@for dir in $(VENDOR_DIRS); do \
		for file in $(CORE_FILES); do \
			mkdir -p "$$dir/$$(dirname $$file)"; \
			cp "core/$$file" "$$dir/$$file"; \
		done; \
		echo "wrote $$dir ($(words $(CORE_FILES)) files)"; \
	done

# Both surfaces are thin adapters over one implementation; if a vendored copy
# drifts from core/ they silently stop behaving the same way.
#
# The .db is compared by bytes here and not by canonical dump, which is the
# opposite of what CI's determinism gate does — deliberately. This check asks
# "did sync-core run?", where both files came off one build and identical bytes
# is the correct expectation. The determinism gate asks "does a rebuild produce
# the same graph?", where the bytes legitimately move with the bundled SQLite
# version. Different questions, different comparisons.
check-vendor:
	@status=0; \
	for dir in $(VENDOR_DIRS); do \
		for file in $(CORE_FILES); do \
			cmp -s "core/$$file" "$$dir/$$file" || { \
				echo "DRIFT $$dir/$$file differs from core/$$file (run: make sync-core)"; \
				status=1; \
			}; \
		done; \
	done; \
	[ $$status -eq 0 ] && echo "ok   $(words $(CORE_FILES)) files in each of: $(VENDOR_DIRS)"; \
	exit $$status

test:
	node --test 'core/*.test.mjs'

verify:
	pnpm run verify

# Proves the MCP server answers a real stdio JSON-RPC session, which the unit
# tests do not cover — they exercise the core, not the transport.
smoke:
	node mcp/smoke.mjs
