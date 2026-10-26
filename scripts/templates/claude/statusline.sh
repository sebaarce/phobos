#!/usr/bin/env bash
# Phobos statusline para Claude Code: 2 lineas + 3ra de subagentes (si hay). Requiere jq
# (sin jq: fallback minimo). Solo lee stdin, git y el audit JSONL; no escribe nada.

IFS= read -rd '' INPUT || true
[ -z "$INPUT" ] && exit 0

if ! command -v jq >/dev/null 2>&1; then
  echo "statusline: jq no esta instalado"
  exit 0
fi

R=$'\e[0m'; BD=$'\e[1m'; GRN=$'\e[32m'; YEL=$'\e[33m'; RED=$'\e[31m'
BLU=$'\e[34m'; GRY=$'\e[90m'; CYA=$'\e[36m'; MAG=$'\e[35m'; WHT=$'\e[97m'
SEP="  ${GRY}│${R}  "

# Un campo por linea; ausente => linea vacia (el segmento se omite).
mapfile -t F < <(jq -r '
  (.model.display_name // ""),
  (.effort.level // ""),
  (.context_window.used_percentage // "" | tostring),
  (.rate_limits.five_hour.used_percentage // "" | tostring),
  (.rate_limits.seven_day.used_percentage // "" | tostring),
  (.agent.name // ""),
  (.workspace.current_dir // .cwd // ""),
  (.cost.total_lines_added // "" | tostring),
  (.cost.total_lines_removed // "" | tostring),
  (.cost.total_cost_usd // "" | tostring),
  (.cost.total_duration_ms // "" | tostring),
  (.session_id // "")
' <<<"$INPUT" 2>/dev/null | tr -d '\r')
MODEL=${F[0]}; EFFORT=${F[1]}; CTX=${F[2]}; RL5=${F[3]}; RL7=${F[4]}; AGENT=${F[5]}
DIR=${F[6]}; ADDED=${F[7]}; REMOVED=${F[8]}; COST=${F[9]}; DURATION=${F[10]}; SESSION_ID=${F[11]}

isnum() { [[ $1 =~ ^[0-9]+(\.[0-9]+)?$ ]]; }
pctcol() { if (($1 > 80)); then C=$RED; elif (($1 >= 50)); then C=$YEL; else C=$GRN; fi; }

L1=""; L2=""
add1() { [ -n "$L1" ] && L1+="$SEP"; L1+="$1"; }
add2() { [ -n "$L2" ] && L2+="$SEP"; L2+="$1"; }
pct_segment() { # etiqueta valor
  local p=${2%.*}; pctcol "$p"
  echo "${GRY}$1${R} ${BD}${C}${p}%${R}"
}

# ---------- LINEA 1: modelo, esfuerzo, contexto, rate limits, agente ----------
[ -n "$MODEL" ] && add1 "${BLU}◆${R} ${BD}${WHT}${MODEL}${R}"
[ -n "$EFFORT" ] && add1 "${GRY}esfuerzo${R} ${BD}${EFFORT}${R}"
isnum "$CTX" && add1 "$(pct_segment ctx "$CTX")"
isnum "$RL5" && add1 "$(pct_segment 5h "$RL5")"
isnum "$RL7" && add1 "$(pct_segment 7d "$RL7")"
[ -n "$AGENT" ] && add1 "${GRY}agente${R} ${CYA}${AGENT}${R}"

# ---------- LINEA 2: directorio, git, lineas, costo, sesion ----------
DIR=${DIR//\\//}
[ -n "$DIR" ] && add2 "${CYA}${DIR%/}${R}"
if [ -n "$DIR" ] && [ -d "$DIR" ]; then
  BRANCH=$(git -C "$DIR" --no-optional-locks branch --show-current 2>/dev/null)
  if [ -n "$BRANCH" ]; then
    s="${MAG}${BRANCH}${R}"
    [ -n "$(git -C "$DIR" --no-optional-locks status --porcelain 2>/dev/null)" ] && s+="${YEL}*${R}"
    add2 "$s"
  fi
fi

if isnum "$ADDED" || isnum "$REMOVED"; then
  add2 "${GRY}líneas${R} ${GRN}+${ADDED:-0}${R} ${RED}-${REMOVED:-0}${R}"
fi
if isnum "$COST"; then
  printf -v COST '%.2f' "$COST"
  add2 "${GRY}costo${R} ${BD}\$${COST}${R}"
fi
if isnum "$DURATION"; then
  secs=$((${DURATION%.*} / 1000)); h=$((secs / 3600)); m=$(((secs % 3600) / 60))
  if ((h > 0)); then span="${h}h ${m}m"; else span="${m}m"; fi
  add2 "${GRY}sesión${R} ${BD}${span}${R}"
fi

# ---------- LINEA 3: subagentes de la sesion (activos + acumulado estimado) ----------
# Fuente unica: audit JSONL (.claude/audit/*.jsonl, junto a este script). Solo se
# leen los 2 archivos mas recientes (dias) y solo registros del session_id actual.
# Registros viejos (sin session_id/tokens) y lineas corruptas se ignoran en silencio;
# cualquier falla deja la statusline en 2 lineas.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)
AUDIT_FILES=()
if [ -n "$SESSION_ID" ] && [ -n "$SCRIPT_DIR" ]; then
  shopt -s nullglob
  ALL_AUDIT=("$SCRIPT_DIR"/audit/*.jsonl)
  shopt -u nullglob
  ((${#ALL_AUDIT[@]} > 2)) && AUDIT_FILES=("${ALL_AUDIT[@]: -2}") || AUDIT_FILES=("${ALL_AUDIT[@]}")
fi

if ((${#AUDIT_FILES[@]} > 0)); then
  PRICES_RAW=$(cat "$SCRIPT_DIR/claude.prices.json" 2>/dev/null)
  [ -z "$PRICES_RAW" ] && PRICES_RAW='{}'
  mapfile -t SUB < <(cat "${AUDIT_FILES[@]}" 2>/dev/null | jq -R -n -r --arg sid "$SESSION_ID" --arg praw "$PRICES_RAW" --argjson topn 3 '
    def rate($p; $m):
      if ($m | type) != "string" then null
      else ([$p | to_entries[] | . as $e | select($m | startswith($e.key))] | sort_by(.key | length) | last | .value) end;
    def cost($r; $t):
      if $r == null then null
      else (($t.input // 0) * ($r.input_per_mtok // 0) + ($t.output // 0) * ($r.output_per_mtok // 0)
          + ($t.cache_read // 0) * ($r.cache_read_per_mtok // 0) + ($t.cache_creation // 0) * ($r.cache_creation_per_mtok // 0)) / 1000000 end;
    ($praw | fromjson? // {}) as $p
    | [inputs | fromjson? | select(type == "object" and .session_id == $sid)] as $ev
    | [$ev[] | select(.event == "SubagentStop") | .agent_id] as $stopped
    | [$ev[] | select(.event == "SubagentStart" and .agent_id != null and (.agent_id as $i | $stopped | index($i) | not)) | .agent_type // empty] as $active
    | ([$ev[] | select(.event == "SubagentStop" and (.tokens | type) == "object" and .agent_type != null)]
        | group_by(.agent_type)
        | map({type: .[0].agent_type, model: (map(.model // empty) | last),
               tokens: (map(.tokens | (.input // 0) + (.output // 0) + (.cache_read // 0) + (.cache_creation // 0)) | add),
               costs: (map(cost(rate($p; .model); .tokens)) | map(select(. != null)))})
        | map(. + {cost: (if (.costs | length) == 0 then null else (.costs | add) end)})) as $done
    | ($done | map(.type)) as $done_types
    | ($done + ([$active[] | select(. as $t | $done_types | index($t) | not)] | unique | map({type: ., model: null, tokens: 0, cost: null})))
    | map(. + {active: (.type as $t | $active | index($t) != null)})
    | sort_by([(.cost // -1), .tokens]) | reverse
    | length as $n
    | (.[0:$topn][] | [.type, (.model // "-"), .tokens, (if .cost == null then "n/d" else .cost end), (if .active then 1 else 0 end)] | @tsv),
      (if $n > $topn then "+\($n - $topn)" else empty end)
  ' 2>/dev/null | tr -d '\r')

  if ((${#SUB[@]} > 0)); then
    L3=""
    add3() { [ -n "$L3" ] && L3+="$SEP"; L3+="$1"; }
    for row in "${SUB[@]}"; do
      if [[ $row == +* ]]; then
        add3 "${GRY}${row} más${R}"
        continue
      fi
      IFS=$'\t' read -r s_type s_model s_tokens s_cost s_active <<<"$row"
      isnum "$s_tokens" || continue
      if ((s_tokens >= 1000)); then s_tok="$((s_tokens / 1000))k"; else s_tok="$s_tokens"; fi
      if isnum "$s_cost"; then printf -v s_cost '~$%.2f' "$s_cost"; else s_cost="n/d"; fi
      s_model=${s_model#claude-}; s_model=${s_model%-20[0-9][0-9][0-9][0-9][0-9][0-9]}
      seg="${CYA}${s_type}${R}"
      [ "$s_model" != "-" ] && seg+=" ${GRY}${s_model}${R}"
      [ "$s_active" = "1" ] && seg="${GRN}▶${R} ${seg}"
      add3 "${seg} ${BD}${s_tok}${R}${GRY} tok${R} ${BD}${s_cost}${R}"
    done
    [ -n "$L3" ] && L3="${GRY}subagentes (est.)${R} ${L3}"
  fi
fi

[ -n "$L1" ] && printf '%s\n' "$L1"
[ -n "$L2" ] && printf '%s\n' "$L2"
[ -n "$L3" ] && printf '%s\n' "$L3"
exit 0
