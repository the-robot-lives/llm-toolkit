# Native macOS host for llm-toolkit.
# Starts or attaches to the Hono process on :3100 (which also serves the console).

.PHONY: build test run app icon install install-osx install-macos install/osx install/macos uninstall-osx clean

SWIFT ?= swift
CONFIG ?= debug
APP_NAME := LLM Toolkit
EXECUTABLE := LLMToolkit
BUILD_DIR := .build
APP_DIR := $(BUILD_DIR)/$(APP_NAME).app
INSTALL_DIR ?= /Applications
TOOLKIT_ROOT := $(shell cd "$(dir $(abspath $(lastword $(MAKEFILE_LIST))))/../.." && pwd)
LSREGISTER := /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

build: ## Compile the Swift package
	$(SWIFT) build -c $(CONFIG)

test: ## Route + locator + launch-plan tests
	$(SWIFT) test

run: ## Launch (attaches to :3100 / starts pnpm dev:api)
	$(SWIFT) run LLMToolkit

app: ## Assemble a double-clickable .app under .build/
	$(SWIFT) build -c release
	@bin="$$($(SWIFT) build -c release --show-bin-path)/$(EXECUTABLE)"; \
	test -x "$$bin"; \
	rm -rf "$(APP_DIR)"; \
	mkdir -p "$(APP_DIR)/Contents/MacOS" "$(APP_DIR)/Contents/Resources"; \
	cp "$$bin" "$(APP_DIR)/Contents/MacOS/$(EXECUTABLE)"; \
	chmod 755 "$(APP_DIR)/Contents/MacOS/$(EXECUTABLE)"; \
	cp Info.plist "$(APP_DIR)/Contents/Info.plist"; \
	printf 'APPL????' > "$(APP_DIR)/Contents/PkgInfo"; \
	printf '%s\n' "$(TOOLKIT_ROOT)" > "$(APP_DIR)/Contents/Resources/toolkit-root.txt"; \
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
