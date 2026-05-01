نسخة معدلة ومراجعة من مشروع dixit-game

تم إصلاح:
- تعارض index.html / app.js / style.css
- شكل الموقع بعد حذف CSS
- حجم الصور وتداخل الكروت
- زر إنشاء غرفة ودخول غرفة
- تشغيل socket عبر window.socket ليستفيد smart-features.js
- زر نسخ رابط الدعوة
- الصوت والتأثيرات
- صورة بروفايل اللاعب

طريقة الرفع:
1) ارفعي كل الملفات إلى GitHub واستبدلي الملفات القديمة.
2) Commit changes.
3) في Render اعملي Manual Deploy > Deploy latest commit.
4) بعد اكتمال deploy افتحي الموقع واضغطي Ctrl + Shift + R.

ملاحظات مهمة:
- بدء اللعبة يحتاج لاعبين على الأقل. إذا كنتِ وحدك سيظهر تنبيه: تحتاج لاعبين على الأقل.
- إذا صورة البروفايل لم تعمل، شغلي ملف SUPABASE_EXTRA_SQL.sql في Supabase SQL Editor.
- تأكدي أن Render Environment يحتوي SUPABASE_URL و SUPABASE_KEY و Cloudinary variables.
