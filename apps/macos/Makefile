# Native macOS host for llm-toolkit.
# Starts or attaches to the bundled local runtime on :3100.

.PHONY: build test run app runtime icon install install-osx install-macos install/osx install/macos uninstall-osx clean

SWIFT ?= swift
PNPM ?= pnpm
CONFIG ?= debug
APP_NAME := LLM Toolkit
EXECUTABLE := LLMToolkit
BUILD_DIR := .build
APP_DIR := $(BUILD_DIR)/$(APP_NAME).app
RUNTIME_DIR := $(APP_DIR)/Contents/Resources/Runtime
INSTALL_DIR ?= /Applications
TOOLKIT_ROOT := $(shell cd "$(dir $(abspath $(lastword $(MAKEFILE_LIST))))/../.." && pwd)
LSREGISTER := /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

build: ## Compile the Swift package
	$(SWIFT) build -c $(CONFIG)

test: ## Route + locator + launch-plan tests
	$(SWIFT) test

run: ## Launch (attaches to :3100 / starts pnpm dev:api in development)
	$(SWIFT) run LLMToolkit

runtime: ## Build web assets that the app embeds into its local runtime
	cd "$(TOOLKIT_ROOT)" && CI=true $(PNPM) --filter @llm-toolkit/web build

app: runtime ## Assemble a double-clickable .app under .build/
	$(SWIFT) build -c release
	@bin="$$($(SWIFT) build -c release --show-bin-path)/$(EXECUTABLE)"; \
	test -x "$$bin"; \
	rm -rf "$(APP_DIR)"; \
	mkdir -p "$(APP_DIR)/Contents/MacOS" "$(APP_DIR)/Contents/Resources" "$(RUNTIME_DIR)/packages"; \
	cp "$$bin" "$(APP_DIR)/Contents/MacOS/$(EXECUTABLE)"; \
	chmod 755 "$(APP_DIR)/Contents/MacOS/$(EXECUTABLE)"; \
	cp Info.plist "$(APP_DIR)/Contents/Info.plist"; \
	printf 'APPL????' > "$(APP_DIR)/Contents/PkgInfo"; \
	cp "$(TOOLKIT_ROOT)/package.json" "$(RUNTIME_DIR)/package.json"; \
	cp "$(TOOLKIT_ROOT)/pnpm-lock.yaml" "$(RUNTIME_DIR)/pnpm-lock.yaml"; \
	cp "$(TOOLKIT_ROOT)/pnpm-workspace.yaml" "$(RUNTIME_DIR)/pnpm-workspace.yaml"; \
	cp "$(TOOLKIT_ROOT)/tsconfig.base.json" "$(RUNTIME_DIR)/tsconfig.base.json"; \
	ditto "$(TOOLKIT_ROOT)/node_modules" "$(RUNTIME_DIR)/node_modules"; \
	mkdir -p "$(RUNTIME_DIR)/packages/api" "$(RUNTIME_DIR)/packages/shared" "$(RUNTIME_DIR)/packages/web"; \
	cp "$(TOOLKIT_ROOT)/packages/api/package.json" "$(RUNTIME_DIR)/packages/api/package.json"; \
	cp "$(TOOLKIT_ROOT)/packages/api/tsconfig.json" "$(RUNTIME_DIR)/packages/api/tsconfig.json"; \
	ditto "$(TOOLKIT_ROOT)/packages/api/src" "$(RUNTIME_DIR)/packages/api/src"; \
	ditto "$(TOOLKIT_ROOT)/packages/api/node_modules" "$(RUNTIME_DIR)/packages/api/node_modules"; \
	cp "$(TOOLKIT_ROOT)/packages/shared/package.json" "$(RUNTIME_DIR)/packages/shared/package.json"; \
	cp "$(TOOLKIT_ROOT)/packages/shared/tsconfig.json" "$(RUNTIME_DIR)/packages/shared/tsconfig.json"; \
	ditto "$(TOOLKIT_ROOT)/packages/shared/src" "$(RUNTIME_DIR)/packages/shared/src"; \
	ditto "$(TOOLKIT_ROOT)/packages/shared/node_modules" "$(RUNTIME_DIR)/packages/shared/node_modules"; \
	cp "$(TOOLKIT_ROOT)/packages/web/package.json" "$(RUNTIME_DIR)/packages/web/package.json"; \
	ditto "$(TOOLKIT_ROOT)/packages/web/dist" "$(RUNTIME_DIR)/packages/web/dist"; \
	ditto "$(TOOLKIT_ROOT)/packages/web/node_modules" "$(RUNTIME_DIR)/packages/web/node_modules"; \
	if [ -f Resources/LLMToolkit.icns ]; then \
		cp Resources/LLMToolkit.icns "$(APP_DIR)/Contents/Resources/LLMToolkit.icns"; \
	fi; \
	for png in Sources/LLMToolkit/Resources/*.png; do \
		[ -f "$$png" ] && cp "$$png" "$(APP_DIR)/Contents/Resources/"; \
	done; \
	codesign --force --deep --sign - "$(APP_DIR)"; \
	echo "✓ $(APP_DIR)"

install install-osx install-macos install/osx install/macos: app ## Build + copy into /Applications (override INSTALL_DIR=)
	mkdir -p "$(INSTALL_DIR)"
	rm -rf "$(INSTALL_DIR)/$(APP_NAME).app"
	ditto "$(APP_DIR)" "$(INSTALL_DIR)/$(APP_NAME).app"
	codesign --force --deep --sign - "$(INSTALL_DIR)/$(APP_NAME).app"
	@if [ -x "$(LSREGISTER)" ]; then \
		"$(LSREGISTER)" -f -R -trusted "$(INSTALL_DIR)/$(APP_NAME).app" >/dev/null 2>&1 || true; \
	fi
	@touch "$(INSTALL_DIR)/$(APP_NAME).app"
	@printf "\nInstalled: %s\n" "$(INSTALL_DIR)/$(APP_NAME).app"
	@printf "Open with:  open \"%s\"\n" "$(INSTALL_DIR)/$(APP_NAME).app"
	@printf "Reveal:     open -R \"%s\"\n\n" "$(INSTALL_DIR)/$(APP_NAME).app"

uninstall-osx: ## Remove the installed .app from INSTALL_DIR
	rm -rf "$(INSTALL_DIR)/$(APP_NAME).app"
	@printf "Removed %s\n" "$(INSTALL_DIR)/$(APP_NAME).app"

icon: ## Rebuild dock icon from Assets/LLMToolkitIcon-1024.png
	bash scripts/generate-app-icon.sh

clean:
	$(SWIFT) package clean
	rm -rf "$(APP_DIR)"
