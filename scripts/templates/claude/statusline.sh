#!/usr/bin/env bash
# Phobos statusline para Claude Code: 2 lineas. Requiere jq (sin jq: fallback minimo).
# Solo lee stdin y git; no escribe nada.

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
  (.cost.total_duration_ms // "" | tostring)
' <<<"$INPUT" 2>/dev/null | tr -d '\r')
MODEL=${F[0]}; EFFORT=${F[1]}; CTX=${F[2]}; RL5=${F[3]}; RL7=${F[4]}; AGENT=${F[5]}
DIR=${F[6]}; ADDED=${F[7]}; REMOVED=${F[8]}; COST=${F[9]}; DURATION=${F[10]}

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

[ -n "$L1" ] && printf '%s\n' "$L1"
[ -n "$L2" ] && printf '%s\n' "$L2"
exit 0
