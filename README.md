# ToolSync VS Code Extension

ToolSync는 공개 배포되지만 철저히 로컬 중심으로 동작하는 도구입니다.
데이터 백업은 사용자 책임 원칙으로 운영합니다.

## 설치 방법 (Marketplace 미사용)
1. GitHub Releases에서 `.vsix` 파일 다운로드
2. VS Code 실행
3. `Extensions` 패널 우측 상단 `...` 클릭
4. `Install from VSIX...` 선택
5. 다운로드한 `.vsix` 파일 선택

## 개발 실행 방법
1. `npm install`
2. `npm run compile`
3. VS Code에서 이 폴더를 열고 `F5` 실행
4. Extension Development Host에서 `ToolSync: 상태 확인` 커맨드 실행

## 패키징
- 1줄 패키징:

```bash
npm run package
```

- 산출물: `dist/toolsync-<version>.vsix`

## 릴리즈/버전 규칙
- SemVer 사용: `X.Y.Z`
- 태그 규칙: `vX.Y.Z` (예: `v0.0.1`)
- 태그 푸시 시 GitHub Actions가 자동으로:
  - 의존성 설치
  - 빌드
  - `.vsix` 패키징
  - GitHub Release 생성
  - Release Asset 업로드

## 보안/주의
- Marketplace 경유가 아니므로 VS Code에서 신뢰 관련 경고가 표시될 수 있습니다.
- ToolSync는 로컬 환경 동기화를 목표로 하며, 클라우드 백업을 제공하지 않습니다.

## 명령어
- `ToolSync: 상태 확인`
- `ToolSync: 초기화`
- `ToolSync: VS Code 스냅샷 저장`
- `ToolSync: 동기화 계획 생성`
- `ToolSync: 동기화 계획 적용 (VS Code)`

## 로컬 동작 흐름
1. `ToolSync: 초기화` 실행
2. `ToolSync: VS Code 스냅샷 저장` 실행
3. `ToolSync: 동기화 계획 생성` 실행
4. `ToolSync: 동기화 계획 적용 (VS Code)` 실행

기본 동기화 폴더(`toolsync.syncRoot`)에 다음 파일이 생성됩니다.

```text
<syncRoot>/
  config.json
  state.json
  snapshots/
    vscode.json
    cursor.json (다른 커넥터가 기록 시)
  registry.json
  plans/
    vscode.json
```

참고:
- 현재 VS Code 적용은 `extension/editor_theme/mcp/skill/env` 항목을 처리합니다.
- `extension`은 실제 설치를 시도합니다.
- `mcp/skill/terminal_theme`는 VS Code 설정 메타데이터로 반영됩니다.
