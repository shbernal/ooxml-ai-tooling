# The shipped core: the implementation modules and the built database they query.
# Every one is copied byte-identically into both surfaces. The tests and
# everything under build/ are deliberately absent — they are development-only and
# must never reach a surface.
CORE_FILES := \
	db.mjs \
	warnings.mjs \
	qname.mjs \
	graph.mjs \
	explain.mjs \
	data/ooxml.db

VENDOR_DIRS := skill/scripts mcp/src

.PHONY: db dump check-schemas sync-core check-vendor test verify smoke help

help:
	@echo "db            build core/data/ooxml.db from schemas/"
	@echo "dump          emit the canonical text serialisation of the database"
	@echo "check-schemas verify the vendored XSDs against schemas/SHA256SUMS"
	@echo "sync-core     copy the core modules and database into both surfaces"
	@echo "check-vendor  verify the vendored copies match"
	@echo "test          run the core suite"
	@echo "verify        lint + typecheck + schemas + tests, the same gate CI runs"
	@echo "smoke         drive the MCP server over real stdio JSON-RPC"

# The database is build output, not source: core/data/ooxml.db is gitignored and
# rebuilt from the committed XSDs. The two *committed* copies live in the
# surfaces (see sync-core), because each is distributed on its own.
db:
	node build/build-db.mjs

# The canonical text serialisation CI hashes. Its format is a contract — see the
# header of build/dump.mjs before changing it.
dump:
	@node build/dump.mjs

# The XSDs are the root of the trust chain: PROVENANCE.md pins the archives,
# SHA256SUMS pins what came out of them. Catches a hand-edit and, more usefully,
# a line-ending rewrite — which happens at checkout rather than at edit time and
# would otherwise surface as an unexplained ingest diff much later.
check-schemas:
	node build/check-schemas.mjs

# Deliberately not automatic. Vendoring is a decision to record in the commit,
# not a side effect of one.
sync-core:
	@for dir in $(VENDOR_DIRS); do \
		for file in $(CORE_FILES); do \
			mkdir -p "$$dir/$$(dirname $$file)"; \
			cp "core/$$file" "$$dir/$$file"; \
		done; \
		echo "wrote $$dir ($(words $(CORE_FILES)) files)"; \
	done

# In Node rather than a shell `cmp` loop, because the .db has to be compared by
# canonical dump rather than by bytes. build/check-vendor.mjs explains why.
check-vendor:
	@node build/check-vendor.mjs

test:
	node --test 'core/*.test.mjs'

verify:
	pnpm run verify

# Proves the MCP server answers a real stdio JSON-RPC session, which the unit
# tests do not cover — they exercise the core, not the transport.
smoke:
	node mcp/smoke.mjs
