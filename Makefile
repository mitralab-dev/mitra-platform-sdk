# ============================================
# MITRA PLATFORM SDK - Makefile
# ============================================
# Usage: make <target>
# Run 'make help' to see all available commands
# ============================================

.PHONY: help build test clean install publish

# Colors
CYAN := \033[36m
GREEN := \033[32m
YELLOW := \033[33m
RESET := \033[0m

# ============================================
# HELP
# ============================================
help:
	@echo ""
	@echo "$(CYAN)╔══════════════════════════════════════════════════════════════╗$(RESET)"
	@echo "$(CYAN)║          MITRA PLATFORM SDK - Development Commands          ║$(RESET)"
	@echo "$(CYAN)╚══════════════════════════════════════════════════════════════╝$(RESET)"
	@echo ""
	@echo "$(GREEN)Commands:$(RESET)"
	@echo "  make install     - Install dependencies"
	@echo "  make build       - Build the SDK (CJS + ESM + types)"
	@echo "  make test        - Run tests"
	@echo "  make clean       - Remove dist/ and node_modules/"
	@echo "  make publish     - Publish to npm registry"
	@echo ""

# ============================================
# TARGETS
# ============================================
install:
	@echo "$(GREEN)Installing dependencies...$(RESET)"
	npm install
	@echo "$(GREEN)Dependencies installed!$(RESET)"

build:
	@echo "$(GREEN)Building mitra-platform-sdk...$(RESET)"
	npm run build
	@echo "$(GREEN)Build complete!$(RESET)"

test:
	@echo "$(GREEN)Running tests...$(RESET)"
	npm test
	@echo "$(GREEN)Tests complete!$(RESET)"

clean:
	@echo "$(YELLOW)Cleaning build artifacts...$(RESET)"
	rm -rf dist node_modules
	@echo "$(GREEN)Clean complete!$(RESET)"

publish:
	@echo "$(GREEN)Publishing to npm...$(RESET)"
	npm publish
	@echo "$(GREEN)Published!$(RESET)"
