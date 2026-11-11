# نشر Zigg على Railway

## 1. ارفع المشروع
- الطريقة الأسهل: من Railway اضغط **New Project > Deploy from GitHub repo** بعد ما ترفع هذا المجلد على GitHub.
- أو بدون GitHub: ثبّت Railway CLI وشغّل داخل المجلد:
  ```
  railway login
  railway init
  railway up
  ```

## 2. المتغيرات (Variables)
بصفحة الخدمة > Variables أضف:
| الاسم | القيمة |
| --- | --- |
| `ADMIN_TOKEN` | كلمة سر طويلة وعشوائية (هذي مفتاح إصدار الأكواد، لا تشاركها) |
| `DB_PATH` | `/data/licenses.db` |
| `APP_VERSION_CODE` | `1` (ارفعه مع كل تحديث) |
| `APP_VERSION_NAME` | `1.0` |

`PORT` يضبطه Railway تلقائياً.

## 3. التخزين الدائم (مهم جداً)
بدون هذا تنمسح قاعدة الأكواد والأجهزة مع كل نشر جديد:
- بصفحة الخدمة: **+ New > Volume**، واربطه بالخدمة على المسار `/data`.

## 4. ملف التطبيق
ضع الـAPK باسم `public/app.apk` داخل المشروع قبل الرفع. مع كل تحديث: استبدل الملف وارفع `APP_VERSION_CODE`.

## 5. الرابط
- Settings > Networking > **Generate Domain** يعطيك رابط مثل `zigg-production.up.railway.app`.
- هذا الرابط ضعه في التطبيق بملف `Config.kt` بسطر `SERVER_URL`، وبعدها ابنِ الـAPK.
- لاحقاً تقدر تربط دومين خاص (مثل `zigg.app`) من نفس الصفحة.

## 6. جرّب
افتح `https://رابطك/health` لازم يرجع `{"ok":true}`، و`https://رابطك/` تظهر صفحة التحميل.

لإصدار كود:
```
curl -X POST https://رابطك/admin/codes -H "Authorization: Bearer ADMIN_TOKEN" -H "Content-Type: application/json" -d "{\"plan\":\"monthly\",\"count\":1}"
```
