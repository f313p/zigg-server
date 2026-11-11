# Zigg: سيرفر الترخيص وصفحة التحميل

سيرفر صغير بدون أي مكتبات خارجية (يحتاج **Node 22 أو أحدث** فقط). يسوي:
- تجربة مجانية 7 أيام تبدأ تلقائياً أول مرة يتصل فيها الجهاز.
- أكواد تفعيل (تصدرها انت وتبيعها أو ترسلها للزبون).
- صفحة تحميل بالعربي بالرابط الرئيسي، وتحميل الـAPK من `/download/app.apk`.

## التشغيل

```bash
cd server
ADMIN_TOKEN="اكتب-نص-طويل-عشوائي" PORT=3000 node server.js
```

متغيرات اختيارية: `APP_VERSION_CODE` و`APP_VERSION_NAME` (ارفعهما مع كل `app.apk` جديد حتى يتحدث التطبيق تلقائياً على الشاشات)، `TRIAL_DAYS` (الافتراضي 7)، `DB_PATH` (الافتراضي `server/data/licenses.db`)، `APK_PATH`.

ضع ملف التطبيق بالاسم `public/app.apk` (أو غيّر `APK_PATH`)، (رقم الدعم 07884266662 موجود بالصفحة).

على السيرفر الحقيقي شغّله خلف HTTPS (مثل Caddy أو Cloudflare)، حتى ما ينكشف الـADMIN_TOKEN.

## إصدار أكواد (للمالك فقط)

```bash
# 5 أكواد شهرية (2,000 د.ع). الباقات: monthly (30 يوم) | yearly (20,000 د.ع، 365 يوم) | lifetime (50,000 د.ع)
curl -X POST https://YOUR-DOMAIN/admin/codes \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"plan":"monthly","count":5,"label":"اسم الزبون او كود الشريك"}'
# أو بعدد أيام مخصص: {"days":30,"count":5}

# تفعيل يدوي لجهاز (بعد دفع يدوي)
curl -X POST https://YOUR-DOMAIN/admin/grant \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"deviceId":"DEVICE_ID","days":30}'

# عرض الأجهزة والأكواد
curl https://YOUR-DOMAIN/admin/devices -H "Authorization: Bearer $ADMIN_TOKEN"
curl https://YOUR-DOMAIN/admin/codes   -H "Authorization: Bearer $ADMIN_TOKEN"
```

## عقد الـAPI للتطبيق (اللي راح نبنيه على الشاشة)

**`POST /api/status`**: التطبيق ينادي عليه كل ما يفتح.
```json
{ "deviceId": "معرّف ثابت للجهاز (8-128 حرف)", "deviceType": "iphone" | "android" }
```
الرد:
```json
{ "status": "trial" | "active" | "expired", "expiresAt": 1794989968233, "daysLeft": 7, "trialDays": 7, "serverTime": 1794385168235 }
```
أول مرة يظهر فيها الجهاز تبدأ التجربة تلقائياً.

**`POST /api/redeem`**: الزبون يكتب الكود.
```json
{ "deviceId": "...", "code": "ABCD-EFGH-JKLM" }
```
أخطاء: `invalid_code` (404)، `code_already_used` (409)، `unknown_device` (404)، `rate_limited` (429).
الكود ينقبل بأحرف صغيرة وبدون شرطات.

قاعدة التطبيق: إذا `status` = `expired` يظهر شاشة تفعيل ويمنع فتح DiPlay/DiAuto. وإذا السيرفر ما انرد (ما اكو نت)، يسمح بآخر حالة معروفة بدل ما يقطع الزبون أثناء السياقة.

## ملاحظات

- **معرّف الجهاز**: التطبيق يولّد معرّف عشوائي ويخزنه. مسح بيانات التطبيق يعطي جهاز جديد وتجربة جديدة. لو صار استغلال، نربط بمعرّف الشاشة أو نحدّد التجربة بالرقم التسلسلي.
- **الحماية**: التحقق على السيرفر. بس إذا الزبون يثبّت DiPlay/DiAuto مباشرة بدون تطبيقنا، ما نقدر نمنعه (انظر المحادثة عن الخيار أ والخيار ب).
- النسخ الاحتياطي: انسخ `server/data/licenses.db` بشكل دوري.


## الدفع

زين كاش إلى `07826205000`. الزبون يرسل الإيصال لواتساب الدعم `07884266662`، وتصدر له كود بالباقة المناسبة (`/admin/codes`).
