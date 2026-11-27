# NPM custom build — bulk SSL + per-domain logs

Bản `jc21/nginx-proxy-manager:2.17.1` (đã vá CVE-2026-123007) cộng thêm hai tính năng.
Source: `/home/binh/bplus_projects/npm-custom` (clone từ tag `v2.17.1`, commit `89c43f56`).

## 1. Log access theo từng domain

Trước: mỗi host có 1 file `proxy-host-<id>_access.log` gộp chung mọi domain trong
`server_name` → không tách được `media.` với `scribd.` với `tool.`.

Sau: mỗi domain một file `*.access.log` riêng.

**Cơ chế** — không thể dùng `$host` trực tiếp trong `access_log`:

```nginx
access_log /data/logs/domains/$host.access.log;   # SAI - path traversal
```

`$host` lấy từ header `Host`, nên `Host: ../../../etc/passwd` sẽ chọn đường dẫn trên
đĩa. Vì vậy dùng `map` — biến chỉ nhận giá trị trong danh sách cố định:

```nginx
# /data/nginx/domains/proxy_host-1.conf  (sinh tự động)
map $host $npm_domain_log_proxy_1 {
  hostnames;
  default "unknown";
  "media.binh.name.vn" "media.binh.name.vn";
  "scribd.binh.name.vn" "scribd.binh.name.vn";
}
```

`hostnames;` cho phép key wildcard (`*.example.com`) khớp subdomain. File của host
wildcard đặt tên `wildcard.example.com.access.log` (không dùng ký tự `*` trong tên file,
tránh rắc rối với glob và logrotate).

`nginx.conf` include `/data/nginx/domains/*.conf` **trước** các host config (biến phải
được khai báo trước khi `server` block dùng).

**Xem log**: trang Logs có thêm nhóm **Domain** trong dropdown. Access đọc file riêng;
Error thì nginx không có file riêng theo domain, nên backend đọc error log của host và
lọc theo `server: <domain>` / `host: "<domain>"` — nói rõ để không hiểu nhầm là có file
error riêng.

**Code**:
- `backend/lib/domain-log-map.js` — validate + sinh nội dung map (dùng chung)
- `backend/internal/domain-log-maps-sync.js` — đồng bộ lúc khởi động, regenerate config
- `backend/internal/nginx.js` — `generateDomainLogMap()` trong `configure()`,
  `deleteDomainLogMap()` trong `deleteConfig()`
- `backend/internal/log-viewer.js` — nguồn `type=domain`
- `backend/templates/{proxy,redirection,dead}_host.conf` — thêm dòng `access_log`
- `docker/rootfs/etc/nginx/nginx.conf`, `logrotate.d`, `prepare/20-paths.sh`
- `frontend/src/pages/Logs/LogViewer.tsx`

**Lúc khởi động**: sync ghi map + regenerate config đã có trên đĩa (vì config do bản cũ
render, chưa có dòng `access_log` mới), rồi reload nginx — chỉ reload khi file thực sự
đổi.

## 2. Gán SSL cert hàng loạt

Hai lối vào:
- **Proxy Hosts**: tick checkbox nhiều host → nút *Assign certificate* → chọn cert
- **Certificates**: menu ⋯ → *Apply to proxy hosts* → tự khớp mọi host mà SAN của cert
  bao phủ

Cả hai mở cùng một modal: bảng host, cờ `uncovered_domains`, chọn Force SSL / HSTS.

**Endpoint**:
```
GET  /api/nginx/certificates/{id}/bulk-preview[?host_ids=1,2]
POST /api/nginx/certificates/{id}/bulk-apply
     { targets: [{host_type, host_id}], ssl_forced, hsts_enabled,
       hsts_subdomains, http2_support, allow_uncovered }
```

**Quyết định thiết kế**:
- SAN đọc từ file PEM (`openssl x509 -text`), **không** tin cột `domain_names` — trên
  production cột này ghi `["CloudFlare,"]` trong khi SAN thật là
  `*.binh.name.vn, binh.name.vn`.
- Wildcard khớp đúng 1 label như nginx/browser: `*.example.com` khớp `a.example.com`,
  không khớp `a.b.example.com` và không khớp apex.
- Host có domain ngoài SAN bị **từ chối riêng lẻ** (`status: error`) trừ khi
  `allow_uncovered: true` — tránh âm thầm gây cảnh báo tên miền.
- `http2_support` mặc định **false** trong bulk apply: không tự bật protocol cho toàn bộ
  host.
- Mỗi host patch đủ 5 field SSL tường minh (patch một phần sẽ để model kế thừa giá trị cũ).
- Re-render qua đúng `internalNginx.configure()` như sửa tay; audit log từng host.
- Lỗi một host không rollback các host khác; response báo `applied`/`failed` + lý do.

## Build & deploy

```bash
# build trên server (Portainer API, không cần copy 2GB image qua LAN)
set -a; source ../bplus-media/.env.deploy; set +a
python3 build_custom_image.py --tag npm-custom:2.17.1

# staging từ bản COPY data thật, port 18080/18443/18181
python3 staging_npm.py up
python3 staging_npm.py down
```

`build_custom_image.py` bỏ stage `nginxproxymanager/testca` khỏi Dockerfile — stage đó
chỉ để nhúng CA tự ký cho test suite của upstream, không ảnh hưởng runtime.

**Deploy production** (chưa làm, cần user quyết định): sửa `image:` trong
`/opt/mediahub/docker-compose.yml` thành tag mới rồi `docker compose up -d --no-deps
nginx-proxy-manager`. Backup trước: `tar -czf` `/data/nginx-proxy-manager` +
`database.sqlite`. Rollback: đổi tag về `2.17.1`.

⚠️ Stack Portainer id=3 vẫn là bẫy (trỏ `/disk1` không tồn tại) — đừng redeploy stack.

## UI v3 — dialog cân lại tỉ lệ (2026-11-26 11:09)

Phản hồi: "vùng cuộn để chọn domain khá nhỏ, các option có giải thích dài dòng và không
cần thiết".

**Trước** (đo trên dialog thật): cert zone 98px, host zone **102px (2 dòng)**, options
131px (4 dòng chữ giải thích). Danh sách — mục đích chính của dialog — lại bé nhất.

**Sửa:**
- Cert picker: một dòng mỗi cert (radio + tên + hạn + badge SAN), `max-height: 7.5rem`
- Options: gộp thành **một hàng checkbox**, bỏ đoạn giải thích dài → chuyển thành
  `title` tooltip trên cả hàng; nhãn rút gọn (`Force SSL`, `HSTS`,
  `Include out-of-scope domains`)
- Body `74vh` (từ 68vh), padding header/row thu lại, row height 49px → 29px
- Cột TYPE và CERTIFICATE CHANGE `white-space: nowrap` + nhãn `In use` thay cho
  "Already using this certificate"

**Sau** (staging, 16 host): cert **53px**, host **336px (9 dòng)**, options **33px**.
Chỉ zone 2 cuộn; modal body không scroll ngoài.

**Bug dữ liệu phát hiện qua ảnh chụp**: badge cert hiện `CloudFlare,` vì lấy từ cột
`certificate.domain_names` (giá trị rác `["CloudFlare,"]` trong DB). Hàng cert đang chọn
giờ hiển thị SAN đọc từ PEM (`*.binh.name.vn`, `binh.name.vn`) — cùng nguồn với preview.

## UI v2 — toolbar gọn + dialog 3 vùng (2026-11-26 09:51)

**1. Nút thao tác hàng loạt lên cạnh nút Add.** Trước đây chọn row sẽ chèn thêm một
`card-header` thứ hai bên dưới, đẩy bảng xuống. Giờ `Assign certificate` / `Clear
selection` và số lượng đã chọn nằm ngay trong hàng toolbar sẵn có, cạnh `Add Proxy
Host`. Chỉ còn **1 card-header** (đã đo), bảng không bị dịch.

**2. Chọn cert trong dialog, không xổ xuống.** Nút `Assign certificate` mở dialog luôn;
danh sách chứng chỉ nằm trong dialog dưới dạng các hàng radio (tên + hạn + SAN badge).
Đổi cert trong dialog sẽ gọi lại preview cho cert đó. Trang Certificates vẫn truyền
cert đang chọn để preselect.

**3. Dialog 3 vùng, chiều cao cố định.** `BulkCertificateModal.module.css`:

| Vùng | Co giãn | Cuộn |
|---|---|---|
| 1. Certificate | `flex: 0 0 auto`, tối đa 34% | chỉ khi nhiều cert |
| 2. Domains/hosts | `flex: 1 1 auto` | **luôn là vùng duy nhất cuộn khi dài** |
| 3. Options | `flex: 0 0 auto` | không |

Body dialog cao `68vh` cố định, nên dialog giữ nguyên kích thước dù 2 hay 24 host; modal
body không bao giờ phát sinh scrollbar ngoài.

**Đo trên staging với 24 host** (15 proxy + 9 dead):

```
zone1: scrolls=false (60/60)
zone2: scrolls=true  (102/1109)   <- chỉ vùng này cuộn
zone3: scrolls=false (93/93)
modal body fits: True
```
Options luôn nằm trong khung nhìn (`visible=true`), nút Apply hiện `Apply certificate (24)`.

## Bug đã sửa sau deploy đầu (2026-11-26 09:20)

**Triệu chứng**: ở tab Proxy Hosts, chọn 1 host để assign cert, dialog lại liệt kê cả
domain của 404 host / redirection host.

**Nguyên nhân gốc**: selection gửi lên server dưới dạng danh sách **id trần**
(`host_ids=1`). Mỗi bảng host có dãy id riêng, nên `proxy_host` #1 và `dead_host` #1 là
hai host khác nhau nhưng cùng id → server trả về cả hai.

**Sửa**: selection giờ là cặp `{host_type, host_id}`.
- `GET /bulk-preview?targets=[{"host_type":"proxy","host_id":1}]` (JSON trong 1 query param)
- `preview()` so khớp theo **cặp** (loại + id); có `targets` thì không auto-match nữa
- `host_ids` (id trần) vẫn giữ cho client API cũ nhưng ghi rõ là không phân biệt được
  hai host cùng id
- Frontend: `onSelectionChange` phát ra `BulkSslTarget[]`, state trong TableWrapper đổi
  từ `number[]` sang `BulkSslTarget[]`

**Kiểm chứng**: `test/bulk-ssl-selection.test.js` (7 test), staging UI chọn proxy #1 →
"Hosts (1/1)" chỉ proxy; trang Certificates → "Hosts (2/2)" auto-match; production API
chọn proxy#1 → `[('proxy', 1)]`.

## ĐÃ DEPLOY PRODUCTION — 2026-11-26 08:49 (+07)

Image: `npm-custom:2.17.1-bplus` (id `c11c837d2bfa`), deploy qua compose project
`mediahub`, downtime ~5 giây.

Backup trước khi deploy: `/home/binh/npm-backup-20261126-084711/`
(`data.tgz` 454KB, `letsencrypt.tgz`, `database.sqlite.before`, `docker-compose.yml.before`).
Compose sửa **đúng 1 dòng**: `jc21/nginx-proxy-manager:2.17.1` → `npm-custom:2.17.1-bplus`
(bản cũ giữ tại `/opt/mediahub/docker-compose.yml.pre-bplus-*`).
Tag rollback: `jc21/nginx-proxy-manager:rollback-2.17.1`.

### Kiểm chứng trên production (sau deploy)

| Kiểm tra | Kết quả |
|---|---|
| Container image / label compose | `npm-custom:2.17.1-bplus` / `mediahub.nginx-proxy-manager` ✅ |
| Volume, network, port | giữ nguyên (`/data` + `/etc/letsencrypt`, `home-network`, 80/81/443) ✅ |
| `nginx -v` | openresty/1.31.8.1 ✅ |
| `nginx -t` (trước và sau bulk apply) | OK ✅ |
| Startup sync (log) | "2 maps written, 2 configs regenerated, 0 maps removed; nginx reloaded" ✅ |
| Config proxy host tự sinh dòng log domain | `access_log /data/logs/domains/$npm_domain_log_proxy_1.access.log` ✅ |
| 3 file log riêng theo domain | `media/scribd/tool.binh.name.vn.access.log`, nội dung đúng domain ✅ |
| `Host: ../../etc/passwd` | 400, không file nào thoát khỏi `/data/logs/domains` ✅ |
| `Host: evil.test` (không khớp server_name) | bị default 443 reject, không tạo file ✅ |
| `/api/logs/sources` | trả 5 domain + host, đúng ✅ |
| `/api/logs/tail?type=domain` | đọc đúng log từng domain, kể cả traffic thật từ Cloudflare (`Client 162.159.98.7`) ✅ |
| Traversal qua API | `400 Unknown domain` ✅ |
| `GET /bulk-preview` qua HTTP | SAN đọc từ PEM, auto-match proxy#1 + dead#1 ✅ |
| `POST /bulk-apply` qua HTTP | 2/2 `applied`, config regenerate, audit log ghi `bulk_ssl_apply: true` ✅ |
| Bulk apply thật sự gán lại cert (detach → apply) | cert 0 → 1, `ssl_forced` false → true ✅ |
| 10 request liên tiếp | 0 lỗi ✅ |
| RestartCount / OOMKilled | 0 / false ✅ |
| 3 domain qua Internet (Cloudflare) | đều `200 http/2 tls=0`, ~0.4s ✅ |
| HTTP → HTTPS redirect | `301 → https://media.binh.name.vn/` ✅ |
| App qua proxy | `/api/v1/modules` 401 (đúng), `scribd.` trả HTML app ✅ |
| 9 container khác | vẫn running, không bị ảnh hưởng ✅ |
| Frontend bundle mới | `index-DyJaqqcL.js`, chứa "Apply certificate to hosts", "Assign certificate", nhóm Domain ✅ |

### Rollback

```bash
docker run --rm -v /opt/mediahub:/mnt alpine \
  sed -i 's|image: npm-custom:2.17.1-bplus|image: jc21/nginx-proxy-manager:rollback-2.17.1|' /mnt/docker-compose.yml
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v /opt/mediahub:/opt/mediahub \
  -w /opt/mediahub docker:cli docker compose -p mediahub -f /opt/mediahub/docker-compose.yml \
  up -d --no-deps nginx-proxy-manager
```

Lưu ý: bản cũ không có tính năng domain log, nên `/data/nginx/domains/` và
`/data/logs/domains/` sẽ thành thừa (vô hại). Config host vẫn tham chiếu
`$npm_domain_log_*` cho tới lần lưu kế tiếp → nên restore `data.tgz` nếu rollback.

## Kiểm chứng đã làm (staging, 2026-11-26)

| Kiểm tra | Kết quả |
|---|---|
| `nginx -v` | openresty/1.31.8.1 (bản vá CVE) |
| `nginx -t` | OK |
| Startup sync | "2 maps written, 2 configs regenerated, 0 maps removed; nginx reloaded" |
| Access log riêng theo domain | media/scribd/tool mỗi domain 1 file, nội dung đúng domain |
| File wildcard | `wildcard.binh.name.vn.access.log` (subdomain khớp qua `hostnames`) |
| `Host` không khớp server_name | bị default 443 reject, **không** tạo file log |
| `Host: ../../../etc/passwd` | 400, không có file nào thoát khỏi `/data/logs/domains` |
| Logs API `type=domain` | trả đúng nội dung từng domain |
| Traversal qua API | `400 Unknown domain` |
| Bulk preview | SAN đọc từ PEM, auto-match 2 host (proxy + dead) |
| Bulk apply qua UI | **Applied: 2, failed: 0** |
| Host có domain ngoài SAN | `status: error` + thông báo rõ |
| `allow_uncovered: true` | apply thành công, liệt kê domain ngoài phạm vi |
| `nginx -t` sau bulk apply | OK, config regenerate đúng |
| Backend test | 87 pass / 0 fail (`domain-log-map` 5, `bulk-ssl-selection` 7, `nginx-values` 75) |
| `validate-schema.js` | Schema is valid |
| Frontend `tsc` + `yarn lint` + `yarn build` | sạch |

Ảnh UI: `.ui-shots/` (modal bulk apply, kết quả apply, Logs theo domain).

## Bug đã tìm thấy & sửa trong quá trình test

1. **Map nhúng trong template host** — test an ninh upstream
   (`test/nginx-values.test.js`) fail: `domain_name` thành tên statement. → Chuyển sang
   sinh file map riêng, template không phụ thuộc giá trị domain.
2. **Dropdown không mở** — thiếu wrapper `.dropdown` quanh nút + menu nên Bootstrap
   không định vị được. → Thêm `div.dropdown`, dùng `button.dropdown-toggle`.
3. **App trắng khi mở modal** — `api/base.ts` camelize mọi response (`humps`), nhưng
   model TypeScript của mình khai báo snake_case → `undefined.length`. → Đổi toàn bộ
   interface sang camelCase.
4. **`data must NOT have additional properties`** — route chèn `certificate_id` vào body
   *trước* khi validate, mà schema cấm property lạ. → Validate body như client gửi, rồi
   mới gắn id từ path.
5. **Log wildcard không đọc được** — viewer tìm `*.example.com.access.log` nhưng file
   tên `wildcard.example.com.access.log`. → Dùng chung `domainLogFileName()`. Có test
   hồi quy.
