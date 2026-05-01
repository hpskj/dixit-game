تحديث تخزين الغرف الدائم

هذا الإصدار يجعل إنشاء/حذف غرف الأدمن وحفظ صور كل غرفة يتم في Supabase بدلاً من data/rooms.json.

قبل رفع النسخة على Render:
1) افتح Supabase > SQL Editor.
2) شغّل ملف SUPABASE_ROOMS_PERSISTENT_SQL.sql مرة واحدة.
3) تأكد أن Render يحتوي:
   SUPABASE_URL
   SUPABASE_KEY = service_role key
   CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
4) ارفع الملفات إلى GitHub ثم اعمل Redeploy في Render.

بعدها أي غرفة تنشئها من لوحة التحكم ستبقى محفوظة حتى بعد إعادة تشغيل Render أو إعادة النشر.
