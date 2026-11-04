#!/bin/sh
# 华天 wise 晚寝签到 —— OpenWrt / busybox 纯 shell 版
# 部署与定时见 README_晚寝签到部署.md

# ============================================================================
# 配置区（要改就改这里；账号用环境变量 WQQD_ACCOUNT1 / WQQD_PASSWORD1）
# ============================================================================
SIGN_URL="${WQQD_SIGN_URL:-${WISE_SIGN_URL:-}}"                  # 签到链接
LAT="${WQQD_LAT:-${WISE_LAT:-88.888888888888888}}"               # 纬度
LNG="${WQQD_LNG:-${WISE_LNG:-88.888888888888888}}"               # 经度
ACC="${WQQD_ACC:-${WISE_ACC:-23.7}}"                             # 定位精度（米）
DRY_RUN="${WQQD_DRY_RUN:-${DRY_RUN:-0}}"                         # 演练模式（1=只演练）
RETRY="${WQQD_RETRY:-${WISE_RETRY:-3}}"                          # 失败重试次数（任何错误都重试，连续这么多次都失败才判失败）
RETRY_WAIT="${WQQD_RETRY_WAIT:-${WISE_RETRY_WAIT:-20}}"          # 每次重试间隔（秒）
NOW_OVERRIDE="${WQQD_NOW:-${WISE_NOW:-}}"                        # 注入时间（测试用）
ACCOUNT="${WQQD_ACCOUNT1:-${WISE_ACCOUNT:?请设置 WQQD_ACCOUNT1（学号）}}"        # 账号
PASSWORD="${WQQD_PASSWORD1:-${WISE_PASSWORD:?请设置 WQQD_PASSWORD1（密码）}}"    # 密码
ROOM_ID="${WQQD_ROOM_ID:-${WISE_ROOM_ID:-}}"                     # 房间 id（留空自动取）
# ============================================================================

# ---- 从签到链接解析站点地址与 taskId ----
if [ -z "$SIGN_URL" ]; then
  echo "❌ 缺少签到链接：请把签到链接整条填进脚本配置区的 SIGN_URL，或设置环境变量 WQQD_SIGN_URL。"
  exit 1
fi
BASE=$(printf '%s' "$SIGN_URL" | sed -n 's#^\(https\?://[^/?#]*\).*#\1#p')
TASK_ID=$(printf '%s' "$SIGN_URL" | sed -n 's/.*[?&]taskId=\([^&#]*\).*/\1/p')
if [ -z "$BASE" ] || [ -z "$TASK_ID" ]; then
  echo "❌ 签到链接无法解析出 taskId：$SIGN_URL"
  echo "   正确格式必须包含 ?taskId=xxxx"
  exit 1
fi

CLIENT_ID="flysource_wise_app"
if [ -n "${WQQD_CLIENT_SECRET:-}" ]; then
  CLIENT_SECRET="$WQQD_CLIENT_SECRET"
elif [ -n "${WISE_CLIENT_SECRET:-}" ]; then
  CLIENT_SECRET="$WISE_CLIENT_SECRET"
else
  CLIENT_SECRET='DA788asdUDjnasd_flysource_dsdadDAIUiuwqe'
fi
TENANT_ID="000000"
UA="Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

# ---- 基础工具函数 ----

# md5：优先 busybox 的 md5sum；返回 32 位小写十六进制
md5s() { printf '%s' "$1" | md5sum | cut -d' ' -f1; }

# base64：优先 busybox base64，退回 openssl；去掉换行
if command -v base64 >/dev/null 2>&1; then
  b64s() { printf '%s' "$1" | base64 | tr -d '\n\r'; }
else
  b64s() { printf '%s' "$1" | openssl base64 | tr -d '\n\r'; }
fi

# 从 JSON 里取字符串字段（值里可能有逗号，如 signWeek）
jget() { printf '%s' "$1" | sed -n 's/.*"'"$2"'":"\([^"]*\)".*/\1/p'; }
# 从 JSON 里取数字字段（无引号，如 "signStatus":0）
jgetnum() { printf '%s' "$1" | sed -n 's/.*"'"$2"'":\(-\{0,1\}[0-9][0-9.]*\).*/\1/p'; }
# "HH:MM:SS" -> 整数（去冒号），供整数比较
tsec() { printf '%s' "$1" | tr -d ':'; }

# ---------------------------------------------------------------------------
# 时间：只用 `date +%s`（UTC epoch，与时区无关），自己换算成 UTC+8
# 不依赖 TZ=CST-8 / date -d / date +%u（busybox 各版本支持不一致）
# ---------------------------------------------------------------------------
if [ -n "$NOW_OVERRIDE" ]; then NOW_E=$NOW_OVERRIDE; else NOW_E=$(date +%s); fi
NOW=$(( NOW_E + 28800 ))
DAYS=$(( NOW / 86400 ))
REM=$(( NOW % 86400 ))
TIME=$(printf '%02d:%02d:%02d' $(( REM / 3600 )) $(( (REM % 3600) / 60 )) $(( REM % 60 )))
# 1970-01-01 是星期四：DOW 0=周日 … 6=周六
DOW=$(( (DAYS + 4) % 7 ))
case "$DOW" in
  1) WEEK="星期一";; 2) WEEK="星期二";; 3) WEEK="星期三";;
  4) WEEK="星期四";; 5) WEEK="星期五";; 6) WEEK="星期六";; *) WEEK="星期日";;
esac
# epoch 天数 -> 年月日（Howard Hinnant civil_from_days，纯整数运算）
_z=$(( DAYS + 719468 )); _era=$(( _z / 146097 )); _doe=$(( _z - _era * 146097 ))
_yoe=$(( ( _doe - _doe / 1460 + _doe / 36524 - _doe / 146096 ) / 365 ))
_yy=$(( _yoe + _era * 400 )); _doy=$(( _doe - (365 * _yoe + _yoe / 4 - _yoe / 100) ))
_mp=$(( (5 * _doy + 2) / 153 )); _dd=$(( _doy - (153 * _mp + 2) / 5 + 1 ))
_mm=$(( _mp + 3 ))
[ "$_mp" -ge 10 ] && _mm=$(( _mp - 9 ))
[ "$_mm" -le 2 ] && _yy=$(( _yy + 1 ))
DATE=$(printf '%04d-%02d-%02d' "$_yy" "$_mm" "$_dd")

# ---------------------------------------------------------------------------
# HTTP：curl 优先，没有就用 wget；统一返回响应正文
# ---------------------------------------------------------------------------
USE_CURL=0
command -v curl >/dev/null 2>&1 && USE_CURL=1

# make_sign <path-only> <token> -> 打印 FlySource-sign 头
# 格式：md5(path?sign + md5(时间戳ms + token)) + "1." + base64(时间戳ms)
make_sign() {
  _ts=$(( $(date +%s) * 1000 ))
  _inner=$(md5s "$_ts$2")
  printf '%s1.%s' "$(md5s "$1?sign=$_inner")" "$(b64s "$_ts")"
}

# http <METHOD> <path+query> <token|-> [json-body]
http() {
  _m=$1; _p=$2; _t=$3; _b=$4
  _pathonly=${_p%%\?*}
  _url="${BASE}${_p}"

  if [ "$USE_CURL" = "1" ]; then
    set -- -sS --max-time 25 -X "$_m" \
      -H "Authorization: $AUTH_BASIC" -H "Tenant-Id: $TENANT_ID" \
      -H "User-Agent: $UA" -H "Accept: application/json"
    if [ "$_t" != "-" ] && [ -n "$_t" ]; then
      set -- "$@" -H "FlySource-Auth: bearer $_t" -H "FlySource-sign: $(make_sign "$_pathonly" "$_t")"
    fi
    if [ -n "$_b" ]; then
      set -- "$@" -H "Content-Type: application/json;charset=UTF-8" --data "$_b"
    fi
    curl "$@" "$_url" 2>/dev/null
  else
    _tb=$(mktemp 2>/dev/null || echo "/tmp/wise_body.$$")
    set -- -q -O - \
      --header="Authorization: $AUTH_BASIC" \
      --header="Tenant-Id: $TENANT_ID" \
      --header="User-Agent: $UA" \
      --header="Accept: application/json"
    if [ "$_t" != "-" ] && [ -n "$_t" ]; then
      set -- "$@" --header="FlySource-Auth: bearer $_t" --header="FlySource-sign: $(make_sign "$_pathonly" "$_t")"
    fi
    if [ -n "$_b" ]; then
      printf '%s' "$_b" > "$_tb"
      set -- "$@" --header="Content-Type: application/json;charset=UTF-8" --post-file="$_tb"
    elif [ "$_m" = "POST" ]; then
      # 空 body 的 POST（登录接口）必须显式声明，否则 wget 默认走 GET
      set -- "$@" --post-data=""
    fi
    wget "$@" "$_url" 2>/dev/null
    rc=$?
    [ -n "$_b" ] && rm -f "$_tb"
    return $rc
  fi
}

AUTH_BASIC="Basic $(b64s "$CLIENT_ID:$CLIENT_SECRET")"

# ---------------------------------------------------------------------------
# 带重试的请求：任何「失败」都重试（常见是 502/503/504 网关错误，返回 HTML 错误页
# 或空响应）。判定失败的情形：响应为空、明显不是 JSON（没有 { 或 }），或含 HTTP 5xx。
# 每次失败等 RETRY_WAIT 秒，连续 RETRY 次都失败才放弃。成功时把响应正文打印到 stdout。
# 用法：http_retry <METHOD> <path+query> <token|-> [json-body]
# 注意：需要判断响应内容的业务校验（如 access_token、code==200）由调用方在拿到结果后做。
# ---------------------------------------------------------------------------
is_bad_resp() {
  # $1 = 响应正文；0=失败(可重试)，1=正常
  [ -z "$1" ] && return 0
  case "$1" in
    *'"code":401'*|*鉴权失败*|*登录过期*) return 1;;   # 鉴权类错误不重试，交给调用方处理
  esac
  case "$1" in
    *'{'*'}'*) : ;;          # 看起来像 JSON，继续往下判断是否 5xx
    *) return 0;;            # 没有 JSON 结构 → HTML 错误页/空壳，判为失败可重试
  esac
  case "$1" in
    *'"status":502'*|*'"status":503'*|*'"status":504'*|*'HTTP 502'*|*'HTTP 503'*|*'HTTP 504'*) return 0;;
  esac
  return 1
}

http_retry() {
  _hr_i=1
  while [ "$_hr_i" -le "$RETRY" ]; do
    _hr_res=$(http "$1" "$2" "$3" "$4")
    if ! is_bad_resp "$_hr_res"; then
      printf '%s' "$_hr_res"
      return 0
    fi
    echo "⚠️ 第 $_hr_i/$RETRY 次请求失败（常见为 502 等网关错误）：$(printf '%s' "$_hr_res" | head -c 160)" >&2
    _hr_i=$(( _hr_i + 1 ))
    [ "$_hr_i" -le "$RETRY" ] && { echo "等待 ${RETRY_WAIT}s 后重试…" >&2; sleep "$RETRY_WAIT"; }
  done
  printf '%s' "$_hr_res"
  return 1
}


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
echo "[$DATE $TIME $WEEK] 登录中…(curl=$USE_CURL)"
LOGIN_JSON=$(http_retry POST "/api/flySource-auth/oauth/token?tenantId=${TENANT_ID}&username=${ACCOUNT}&password=$(md5s "$PASSWORD")&type=account&grant_type=password&scope=all" "-")
TOKEN=$(jget "$LOGIN_JSON" access_token)
if [ -z "$TOKEN" ]; then
  echo "❌ 登录失败（已重试 $RETRY 次）：$(printf '%s' "$LOGIN_JSON" | head -c 300)"
  exit 1
fi
echo "登录成功"

TASK_JSON=$(http_retry GET "/api/flySource-yxgl/dormSignTask/getTaskByIdForApp?taskId=${TASK_ID}" "$TOKEN")
START_T=$(jget "$TASK_JSON" signStartTime); START_T=${START_T:-21:00:00}
END_T=$(jget "$TASK_JSON" signEndTime);   END_T=${END_T:-23:00:00}
TASK_TYPE=$(jget "$TASK_JSON" taskType);  TASK_TYPE=${TASK_TYPE:-1}
SIGN_WEEK=$(jget "$TASK_JSON" signWeek)
START_DATE=$(jget "$TASK_JSON" taskStartDate)
END_DATE=$(jget "$TASK_JSON" taskEndDate)
RID=$(jget "$TASK_JSON" roomId)
[ -n "$RID" ] && ROOM_ID="$RID"
if [ -z "$ROOM_ID" ]; then
  echo "❌ 取不到宿舍房间 id（roomId），请检查任务是否属于你的账号：$(printf '%s' "$TASK_JSON" | head -c 300)"
  exit 1
fi

echo "任务：时段 $START_T-$END_T | 宿舍房号 roomId=$ROOM_ID | 允许半径 $(jget "$TASK_JSON" locationAccuracy)米"

# 日期范围
if [ -n "$START_DATE" ] && [ "$DATE" \< "$START_DATE" ]; then
  echo "今天($DATE)早于任务开始日($START_DATE)，退出"; exit 0
fi
if [ -n "$END_DATE" ] && [ "$DATE" \> "$END_DATE" ]; then
  echo "今天($DATE)晚于任务结束日($END_DATE)，退出"; exit 0
fi
# 星期
if [ -n "$SIGN_WEEK" ] && ! printf '%s' "$SIGN_WEEK" | grep -q "$WEEK"; then
  echo "今天${WEEK}不是签到日，退出"; exit 0
fi
# 时段：只允许 signStartTime <= TIME <= signEndTime 时提交
if [ "$(tsec "$TIME")" -lt "$(tsec "$START_T")" ]; then
  echo "还没到签到时间（$START_T），退出"; exit 0
fi
if [ "$(tsec "$TIME")" -gt "$(tsec "$END_T")" ]; then
  echo "已过签到结束时间（$END_T），退出"; exit 0
fi

# 已签检查
REC_JSON=$(http_retry GET "/api/flySource-yxgl/dormSignRecord/getOne?taskId=${TASK_ID}&signDate=${DATE}&taskType=${TASK_TYPE}" "$TOKEN")
STATUS=$(jgetnum "$REC_JSON" signStatus)
case "$STATUS" in
  0|1|2|4|5|6)
    SIGN_T=$(jget "$REC_JSON" signTime)
    SIGN_ACC=$(jgetnum "$REC_JSON" locationAccuracy)
    echo "今天已签到（${SIGN_T:-?}，距离 ${SIGN_ACC:-?} 米），无需重复"; exit 0;;
esac

# 组装请求体（与前端逐字段一致）
STU_PAYLOAD="{\"latitude\":\"${LAT}\",\"longitude\":\"${LNG}\",\"locationAccuracy\":\"${ACC}\",\"signDate\":\"${DATE}\",\"taskId\":\"${TASK_ID}\",\"fileId\":\"\"}"
STU_TASK_ID=$(md5s "$STU_PAYLOAD")
# 前端用的是 md5(new Date().toString())，这里同样用「当前时间字符串」即可（服务端不校验其格式）
SIGN_CODE=$(md5s "$(date)")
BODY="{\"signType\":0,\"taskId\":\"${TASK_ID}\",\"signLat\":${LAT},\"signLng\":${LNG},\"locationAccuracy\":${ACC},\"stuTaskId\":\"${STU_TASK_ID}\",\"scanCode\":\"\",\"scanType\":\"\",\"roomId\":\"${ROOM_ID}\",\"signKey\":\"${ROOM_ID}\",\"signCode\":\"${SIGN_CODE}\"}"

echo "提交坐标 $LAT, $LNG（距宿舍 ${ACC} 米）"
if [ "$DRY_RUN" = "1" ]; then
  echo "$BODY"; echo "DRY_RUN=1，未提交"; exit 0
fi

i=1
while [ "$i" -le "$RETRY" ]; do
  RES=$(http POST "/api/flySource-yxgl/dormSignRecord/stuSign" "$TOKEN" "$BODY")
  echo "第 $i 次响应：$(printf '%s' "$RES" | head -c 400)"
  case "$RES" in
    *'"code":200'*)
      echo "✅ 签到成功"
      # 回查确认
      CHK=$(http_retry GET "/api/flySource-yxgl/dormSignRecord/getOne?taskId=${TASK_ID}&signDate=${DATE}&taskType=${TASK_TYPE}" "$TOKEN")
      echo "回查：$(printf '%s' "$CHK" | head -c 300)"
      exit 0;;
    *'已完成签到'*)
      echo "今天已签到（服务端提示重复），视为成功"; exit 0;;
  esac
  i=$(( i + 1 ))
  [ "$i" -le "$RETRY" ] && { echo "等待 ${RETRY_WAIT}s 后重试…"; sleep "$RETRY_WAIT"; }
done
echo "❌ 签到失败（已重试 $RETRY 次）"
exit 1

# ============================================================================
# OpenWrt 部署与定时（crontab）说明 —— 详见 README_晚寝签到部署.md
#   1) scp 到 /root/wise_dorm_sign.sh 并 chmod +x
#   2) 改本文件配置区的 SIGN_URL（必填，整条签到链接）
#   3) 手动演练：WQQD_ACCOUNT1=学号 WQQD_PASSWORD1='密码' WQQD_DRY_RUN=1 sh /root/wise_dorm_sign.sh
#   4) /etc/crontabs/root 加两条（21:01 主 / 22:02 兜底）：
#        1 21 * * *  WQQD_ACCOUNT1=学号 WQQD_PASSWORD1='密码' /bin/sh /root/wise_dorm_sign.sh >> /tmp/wise_sign.log 2>&1
#        2 22 * * *  WQQD_ACCOUNT1=学号 WQQD_PASSWORD1='密码' /bin/sh /root/wise_dorm_sign.sh >> /tmp/wise_sign.log 2>&1
#      /etc/init.d/cron enable && /etc/init.d/cron restart
#   5) 时区（cron 用路由器本地时区）：
#        uci set system.ntp.timezone='CST-8'; uci commit system; /etc/init.d/system restart
# ============================================================================
