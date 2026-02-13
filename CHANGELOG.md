# Changelog

## 0.0.4
- Added apply retry policy with linear backoff (`applyRetryCount`, `applyRetryDelaySec`)
- Added exclusion lists for extension/MCP/Skill sync targets
- Added error/runtime log management and log rotation
- Added diagnostic report command (`ToolSync: 에러/진단 리포트 생성`)
- Added log/report settings for error reporting workflow

## 0.0.3
- Added auto sync controller with interval loop and queued cycle handling
- Added change-triggered sync on extension/config/theme updates
- Added commands: sync now, auto start, auto stop
- Added auto-sync configuration options

## 0.0.2
- Added local sync loop commands: init/snapshot/plan/apply
- Added snapshot/registry/plan generation in local sync root
- Added VS Code plan apply handler (extension/theme/env/mcp/skill)

## 0.0.1
- Initial ToolSync VS Code extension scaffold
- Added command: `ToolSync: 상태 확인`
- Added VSIX packaging script and GitHub Release workflow
