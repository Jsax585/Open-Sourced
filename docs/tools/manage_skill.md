# manage_skill

> 격리된 관리형 스킬을 생성, 갱신 또는 삭제합니다.

## 소스
- 진입점: `packages/coding-agent/src/tools/manage-skill.ts`
- 모델용 프롬프트: `packages/coding-agent/src/prompts/tools/manage-skill.md`
- 관리형 스킬 도우미: `packages/coding-agent/src/autolearn/managed-skills.ts`
- 스킬 검색: `packages/coding-agent/src/extensibility/skills.ts`

## 등록 / 노출
- 도구 메타데이터: `approval = "write"`, `strict = true`, `loadMode = "essential"`. `xd://` 아래에 마운트하지 않고 최상위에 유지합니다.
- 등록에는 `autolearn.enabled = true`(기본값 `false`)가 필요하지만 `memory.backend`와는 독립적입니다.
- 활성화된 최상위 세션에서는 일반적인 명시적 도구 목록에 자동으로 포함합니다. 하위 에이전트는 이를 검색하거나 자동으로 받지 않지만, 요청 도구/frontmatter 목록에 명시적으로 포함되어 있으면 사용할 수 있습니다.
- 실행은 단일 실행이며 진행 상황을 내보내지 않습니다.

## 입력

| 필드 | 유형 | 필수 | 설명 |
|---|---|---:|---|
| `action` | `"create" \| "update" \| "delete"` | 예 | 관리형 스킬 변경 작업. |
| `name` | `string` | 예 | 관리형 스킬 이름. 경로를 결정하기 전에 앞뒤 공백을 제거하고 소문자로 변환한 뒤 `[a-z0-9][a-z0-9-]{0,63}`에 맞는지 검증합니다. |
| `description` | `string` | 생성/갱신 | 스킬 검색에 사용할 한 줄 설명. |
| `body` | `string` | 생성/갱신 | `SKILL.md`의 Markdown 본문. frontmatter를 포함하지 마세요. |

## 출력
- `delete`: `content[0].text = "Deleted managed skill \"<name>\"."`, `details = { action: "delete", name }`
- `create`: `content[0].text = "Created managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`, `details = { action: "create", name }`
- `update`: `content[0].text = "Updated managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`, `details = { action: "update", name }`
- 결과의 이름은 전달된 `name`을 그대로 표시합니다. 생성/갱신 경로는 디스크상의 정규화된 이름을 사용합니다.
- 생성 시 작성자 스킬과 이름이 충돌하면 `isError: true`와 `details = { action: "create", name, shadowed: true }`를 반환합니다.

## 흐름
1. `ManageSkillTool.createIf(...)`는 `autolearn.enabled`가 true일 때만 도구를 노출하고, 세션의 선택적 `refreshSkills` 콜백을 저장합니다.
2. 스키마 검증은 `create` / `update`에 `description`과 `body`를 모두 요구합니다. `delete`에는 `name`만 필요합니다.
3. `delete`는 `deleteManagedSkill(name)`을 호출한 뒤 콜백이 있으면 활성 스킬을 새로 고칩니다.
4. `create`는 이름을 정규화하고 활성 작성자 스킬이 이미 그 이름을 사용하는지 확인합니다. 사용 중이면 쓰지 않고 오류 결과를 반환합니다.
5. `create` / `update`는 `writeManagedSkill(...)`을 호출합니다. 이 함수는 이름 정규화/검증, 생성할 frontmatter 정제, 동일 이름에 대한 프로세스 내 쓰기 직렬화를 수행하고 관리형 스킬 루트 아래에 `SKILL.md`를 씁니다.
6. 생성/갱신에 성공하면 콜백이 있는 경우 활성 스킬을 새로 고치므로 대화형 세션이 변경 사항을 즉시 발견할 수 있습니다.
   새로 고침 실패는 파일 시스템 변경 후 상위로 전파되며 스킬을 롤백하지 않습니다.

## 모드 / 변형
- `create`: 배타적 생성(`wx`) 방식으로 `SKILL.md`를 만듭니다. 이미 존재하면 실패합니다. 배타적 생성이며 임시 파일/이름 변경 트랜잭션은 아닙니다.
- `update`: 기존의 일반 파일이며 하드 링크가 하나인 관리형 `SKILL.md`를 덮어씁니다. 파일이 없으면 실패합니다.
- `delete`: 기존 관리형 스킬 디렉터리를 재귀적으로 삭제합니다. 없으면 실패합니다.
- 정규화된 이름이 같은 변경은 프로세스 내에서 제출 순서대로 직렬화됩니다. 이름이 다르면 병렬로 진행할 수 있습니다. 프로세스 간 경합은 직렬화하지 않습니다.

## 부수 효과
- 파일 시스템: `<agent-dir>/managed-skills/<name>/SKILL.md`를 쓰거나 삭제합니다. 기본 에이전트 디렉터리는 `~/.omp/agent`입니다.
- 네트워크: 없습니다.
- 세션 상태: 도구 생성 시 `autolearn.enabled`를 읽고, 변경에 성공하면 `refreshSkills`가 있을 때 활성 스킬 목록을 새로 고칩니다.
- 백그라운드 작업: 없습니다.

## 제한 및 상한
- 사용하려면 `autolearn.enabled = true`가 필요합니다.
- 이름은 앞뒤 공백을 제거하고 소문자로 변환한 뒤 `[a-z0-9][a-z0-9-]{0,63}`에 맞아야 합니다.
- 설명은 한 줄로 정제하며 제어/서식 문자, 꺾쇠괄호, 백틱, 반복된 물결표를 제거합니다.
- 본문은 앞뒤 공백을 제거한 뒤에도 비어 있지 않아야 합니다. 생성된 frontmatter에는 정규화된 `name`과 정제된 `description`만 포함합니다.
- 최종 관리형 `SKILL.md` 콘텐츠는 frontmatter와 설명을 포함해 UTF-8 `64_000`바이트로 제한됩니다.
- 심볼릭 링크를 통한 경로 이탈을 방지하기 위해 관리형 스킬 루트, 스킬 디렉터리, 파일을 검사합니다. 갱신은 일반 파일이 아니거나 하드 링크가 여러 개인 파일도 거부합니다.

## 오류
- 유효하지 않은 이름은 `Invalid skill name "<raw>"...`를 던집니다.
- `description`과 `body` 중 하나라도 없는 생성/갱신은 스키마 검증에서 거부합니다. 실행 시 방어적 오류는 `"<action>" requires both "description" and "body".`입니다.
- 정제 후 빈 설명은 `Managed skill "<name>" needs a non-empty description.`을 던집니다.
- 공백 제거 후 빈 본문은 `Managed skill "<name>" needs a non-empty body.`를 던집니다.
- 최종 파일이 너무 크면 `Managed skill is <bytes> bytes; the limit is 64000.`을 던집니다.
- 기존 관리형 파일에 대한 `create`와 없는 대상에 대한 `update`/`delete`는 작업별 도우미 오류를 던집니다.
- `create`에서 작성자 스킬과 이름이 충돌하면 `isError: true`와 `details.shadowed = true`인 정상 도구 결과를 반환하며, 파일을 쓰지 않습니다.
- 안전하지 않은 루트, 심볼릭 링크인 디렉터리/파일, 일반 파일이 아닌 파일, 하드 링크가 여러 개인 갱신 대상 파일은 안전성 오류를 던집니다.

## 참고
- 관리형 스킬은 `<agent-dir>/managed-skills` 아래에 생성하며 작성자 스킬은 편집하지 않습니다.
- `body`에 YAML frontmatter를 포함하지 마세요. `writeManagedSkill(...)`이 정규화된 `name`과 정제된 `description` frontmatter를 생성합니다.
- `update`는 작성자 스킬 우선순위를 우회하지 않습니다. 같은 이름의 작성자 스킬이 있으면 검색 시 관리형 스킬은 계속 가려집니다.
