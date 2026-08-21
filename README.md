# Catalyst WhatsApp Quiz v4.5.0

نظام مستقل عن The Catalyst الأساسي.

## التشغيل
```bash
npm install
npm run build
npm start
```

ثم:
- لوحة المدير: http://localhost:4000/admin
- بوابة الطالب: http://localhost:4000/student

ضع `GEMINI_API_KEY` في `.env` لتفعيل توليد الاختبارات بالذكاء الاصطناعي.

## الاختبارات المتعددة
يمكن إنشاء أي عدد من الاختبارات. لكل اختبار:
- الصف الدراسي
- المجموعات المسموح لها
- حالة نشر/إيقاف
- ترتيب للتتابع

على WhatsApp:
- `اختبار` أو `بدء` لعرض قائمة الاختبارات المتاحة.
- إرسال رقم الاختبار لاختيار اختبار محدد.
- `متتابع` لحل الاختبارات النشطة بالترتيب.
- عند انتهاء اختبار في وضع التتابع ينتقل النظام تلقائياً للاختبار النشط التالي، متجاوزاً أي اختبار تم إيقافه.
- يتم حفظ نتيجة مستقلة لكل اختبار.

## Gemini واستيراد المصادر
لوحة المدير تقبل Word/PDF/PowerPoint/Excel/TXT/CSV والصور، وتستخرج النص والمرفقات المتاحة ثم ترسل المصدر المناسب إلى Gemini لتوليد أسئلة قابلة للمراجعة قبل النشر.

## WhatsApp
لا تشغل WAHA أثناء اختبار الواجهة المحلية. بعد نجاح لوحة المدير/الطالب، شغّل WAHA واربط الـ webhook ثم اختبر WhatsApp فعلياً.


## v4.5.1 fixes
- New quiz workflow supports creating another quiz from the same source or a new file.
- Removed the repeated demo-quiz creation path from the main workflow.
- Admin dashboard auto-refreshes pending student registrations every 3 seconds.
- API responses are marked no-cache to prevent stale student/admin data.
