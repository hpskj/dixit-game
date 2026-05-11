# تحويل Dixit Q8 إلى تطبيق PWA

تمت إضافة ملفات التطبيق:

- `public/manifest.webmanifest`
- `public/sw.js`
- `public/pwa.js`
- `public/icon-192.png`
- `public/icon-512.png`

## طريقة التجربة

1. ارفع كل الملفات على Render.
2. اعمل Redeploy.
3. افتح الموقع من الجوال.
4. في Android/Chrome سيظهر زر **تثبيت التطبيق** أو من قائمة المتصفح اختر Install app.
5. في iPhone/Safari اختر: Share ثم **Add to Home Screen**.

## ملاحظات

- اللعبة ما زالت تحتاج إنترنت لأن اللعب الجماعي وSocket.IO يعتمد على السيرفر.
- الـ PWA يجعل الموقع يظهر كتطبيق بأيقونة وشاشة مستقلة.
- لا يحتاج SQL جديد.
