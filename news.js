// IceMorocco News editorial seed content.
// Articles are deliberately evergreen and practical until an editorial publishing workflow is connected.
const NEWS_CATEGORIES = {
  maroc: { label: 'Maroc', description: 'Actualités, services publics et vie quotidienne au Maroc.' },
  economie: { label: 'Économie', description: 'Entreprises, emploi, pouvoir d’achat et économie marocaine.' },
  societe: { label: 'Société', description: 'Démarches, éducation, santé et sujets qui concernent les familles.' },
  sport: { label: 'Sport', description: 'Les rendez-vous et résultats sportifs qui intéressent le public marocain.' },
  monde: { label: 'Monde', description: 'Les faits internationaux qui ont un impact sur le Maroc.' },
};

const NEWS_ARTICLES = [
  {
    slug: 'nouvelles-demarches-administratives-maroc-guide-pratique', category: 'maroc',
    title: 'Démarches administratives au Maroc : le guide pratique pour gagner du temps',
    excerpt: 'Documents, rendez-vous et vérifications utiles avant de se déplacer dans une administration.',
    date: '2026-08-10', readTime: '6 min', image: 'https://images.unsplash.com/photo-1539650116574-75c0c6d73f6e?auto=format&fit=crop&w=1400&q=85',
    arTitle: 'الإجراءات الإدارية في المغرب: دليل عملي لتوفير الوقت', arExcerpt: 'الوثائق والمواعيد والتحققات المفيدة قبل التوجه إلى الإدارة.', arIntro: 'تبدأ كل مسطرة إدارية ناجحة قبل موعدها. إن تجهيز الوثائق الصحيحة والتحقق من القناة الرسمية يقللان من التنقلات غير الضرورية والملفات الناقصة.',
    intro: 'Une démarche administrative réussie commence avant le rendez-vous. En préparant les bons documents et en vérifiant le canal officiel, vous réduisez les déplacements inutiles et les dossiers incomplets.',
    sections: [
      ['Préparer son dossier', 'Commencez par identifier l’administration responsable, puis consultez sa page officielle. Notez les pièces exigées, le format des photos, les copies nécessaires et la durée de validité des documents. Gardez les originaux séparés des copies.'],
      ['Vérifier le rendez-vous', 'Certaines procédures nécessitent une prise de rendez-vous, tandis que d’autres acceptent le dépôt en ligne ou au guichet. Utilisez uniquement le site officiel indiqué par l’administration et conservez la confirmation reçue.'],
      ['Avant de partir', 'Contrôlez l’adresse du service, les horaires, les moyens de paiement acceptés et les éventuels frais. Une liste simple sur téléphone permet de vérifier chaque pièce au dernier moment.'],
    ],
    official: 'https://www.service-public.ma/',
  },
  {
    slug: 'auto-entrepreneur-maroc-ce-qui-change-pour-les-independants', category: 'economie',
    title: 'Auto-entrepreneur au Maroc : les points à vérifier avant de commencer',
    excerpt: 'Activité, déclarations, factures et organisation : les bases à connaître avant de se lancer.',
    date: '2026-08-08', readTime: '7 min', image: 'https://images.unsplash.com/photo-1556761175-b413da4baf72?auto=format&fit=crop&w=1400&q=85',
    arTitle: 'المقاول الذاتي في المغرب: نقاط يجب التحقق منها قبل البدء', arExcerpt: 'النشاط والتصريحات والفواتير والتنظيم: الأساسيات التي يجب معرفتها قبل الانطلاق.', arIntro: 'يجذب نظام المقاول الذاتي العديد من المستقلين وأصحاب المشاريع الصغيرة. قبل التسجيل، من المهم التحقق من أهلية النشاط وفهم الالتزامات التي تلي إنشاء النشاط.',
    intro: 'Le régime de l’auto-entrepreneur attire de nombreux freelances et porteurs de petits projets. Avant l’inscription, il est important de vérifier que l’activité est éligible et de comprendre les obligations qui suivent la création.',
    sections: [
      ['Choisir une activité adaptée', 'Décrivez l’activité avec précision et vérifiez les conditions applicables. Une activité réglementée peut nécessiter des autorisations supplémentaires, même lorsque l’inscription est simple.'],
      ['Organiser les recettes', 'Conservez les factures, contrats et preuves de paiement dans un dossier mensuel. Cette organisation facilite les déclarations et permet de répondre aux questions d’un client.'],
      ['Utiliser les sources officielles', 'Les plafonds, taux et échéances peuvent évoluer. Consultez le portail officiel avant toute décision fiscale et demandez conseil à un professionnel lorsque la situation est complexe.'],
    ],
    official: 'https://rn.ae.gov.ma/',
  },
  {
    slug: 'prix-carburant-maroc-comprendre-les-variations', category: 'economie',
    title: 'Prix des carburants au Maroc : pourquoi les tarifs peuvent varier',
    excerpt: 'Les principaux facteurs qui expliquent l’évolution du prix affiché à la pompe.',
    date: '2026-08-06', readTime: '5 min', image: 'https://images.unsplash.com/photo-1521791055366-0d553872125f?auto=format&fit=crop&w=1400&q=85',
    arTitle: 'أسعار المحروقات في المغرب: فهم أسباب التغيرات', arExcerpt: 'أهم العوامل التي تفسر تغير السعر المعروض في محطات الوقود.', arIntro: 'يتأثر السعر الذي يؤديه المستهلك في المحطة بعدة عناصر، منها السعر الدولي والنقل وسعر الصرف والتوزيع والضرائب.',
    intro: 'Le prix payé à la station dépend de plusieurs éléments. Le cours international, le transport, le change, les coûts de distribution et les taxes participent tous au prix final.',
    sections: [
      ['Le marché international', 'Le pétrole et les produits raffinés évoluent selon l’offre mondiale, la demande, les tensions géopolitiques et les décisions des grands producteurs.'],
      ['Le dirham et la logistique', 'Le taux de change et les coûts d’acheminement influencent également le coût d’approvisionnement. L’effet n’apparaît pas toujours immédiatement à la pompe.'],
      ['Comparer intelligemment', 'Pour suivre une évolution, comparez les prix sur plusieurs jours et dans plusieurs stations. Une différence locale peut venir de la concurrence, de la zone ou du service proposé.'],
    ],
    official: 'https://www.mcinet.gov.ma/',
  },
  {
    slug: 'rentrée-scolaire-maroc-conseils-familles', category: 'societe',
    title: 'Rentrée scolaire au Maroc : conseils simples pour bien préparer la famille',
    excerpt: 'Budget, fournitures, transport et organisation : une méthode claire pour commencer l’année.',
    date: '2026-08-04', readTime: '6 min', image: 'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?auto=format&fit=crop&w=1400&q=85',
    arTitle: 'الدخول المدرسي في المغرب: نصائح بسيطة للاستعداد', arExcerpt: 'الميزانية واللوازم والنقل والتنظيم: طريقة واضحة لبدء السنة الدراسية.', arIntro: 'تصبح فترة الدخول المدرسي أسهل عندما يتم توزيع المشتريات والإجراءات على مراحل. ويساعد الاستعداد التدريجي على تجنب المصاريف المستعجلة.',
    intro: 'La rentrée est plus facile lorsque les achats et les formalités sont répartis dans le temps. Une préparation progressive évite les dépenses précipitées et permet de vérifier les besoins réels de chaque enfant.',
    sections: [
      ['Faire une liste utile', 'Commencez par les fournitures demandées par l’établissement. Réutilisez ce qui est encore en bon état et comparez les prix avant les achats importants.'],
      ['Prévoir les dépenses', 'Séparez les frais fixes, comme l’inscription ou le transport, des achats variables. Cette distinction aide à construire un budget réaliste.'],
      ['Reprendre le rythme', 'Quelques jours avant la rentrée, avancez progressivement l’heure du coucher et préparez les trajets. Les enfants retrouvent ainsi leurs habitudes sans changement brutal.'],
    ],
    official: 'https://www.men.gov.ma/',
  },
  {
    slug: 'resultats-foot-maroc-calendrier-et-informations', category: 'sport',
    title: 'Football marocain : comment suivre les calendriers et résultats officiels',
    excerpt: 'Les bons réflexes pour retrouver une rencontre, un classement ou une convocation.',
    date: '2026-08-02', readTime: '4 min', image: 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?auto=format&fit=crop&w=1400&q=85',
    arTitle: 'كرة القدم المغربية: كيف تتابع المواعيد والنتائج الرسمية', arExcerpt: 'طرق موثوقة للعثور على مباراة أو ترتيب أو استدعاء.', arIntro: 'قد تتغير مواعيد المباريات بسبب النقل التلفزيوني أو التنقلات أو المنافسات. ولتفادي المعلومات المتضاربة، من الأفضل التحقق من المصدر الرسمي قبل التوجه إلى الملعب.',
    intro: 'Les calendriers peuvent être modifiés selon la télévision, les déplacements ou les compétitions. Pour éviter les informations contradictoires, il vaut mieux vérifier la source officielle avant un déplacement au stade.',
    sections: [
      ['Vérifier la compétition', 'Identifiez le championnat, la coupe ou la sélection concernée. Les horaires et les règles ne sont pas les mêmes selon la compétition.'],
      ['Consulter les comptes officiels', 'Les fédérations et clubs publient les changements de dernière minute. Vérifiez la date de publication lorsque plusieurs horaires circulent.'],
      ['Préparer le déplacement', 'Tenez compte de l’accès au stade, du billet et des consignes de sécurité. Arriver en avance rend l’expérience plus agréable.'],
    ],
    official: 'https://frmf.ma/',
  },
  {
    slug: 'maroc-actualites-a-suivre-cette-semaine', category: 'maroc',
    title: 'Maroc : les informations pratiques à suivre cette semaine',
    excerpt: 'Un point de repère pour les services publics, les échéances et les annonces importantes.',
    date: '2026-08-01', readTime: '5 min', image: 'https://images.unsplash.com/photo-1516026672322-bc52d61a55d5?auto=format&fit=crop&w=1400&q=85',
    arTitle: 'المغرب: معلومات عملية يجب متابعتها هذا الأسبوع', arExcerpt: 'نقطة مرجعية للخدمات العمومية والمواعيد والإعلانات المهمة.', arIntro: 'لا تقتصر الأخبار المفيدة على العناوين الكبرى. فقد تؤثر تغييرات المواعيد والإجراءات الرقمية والإعلانات العمومية مباشرة على الحياة اليومية.',
    intro: 'L’actualité utile ne se limite pas aux grands titres. Les changements d’horaires, les démarches en ligne et les annonces publiques peuvent avoir un effet direct sur la vie quotidienne.',
    sections: [
      ['Priorité aux sources vérifiées', 'Avant de partager une annonce, recherchez le communiqué original ou la page de l’organisme concerné. Une capture d’écran isolée ne suffit pas toujours à comprendre le contexte.'],
      ['Noter les échéances', 'Les dates de concours, paiements, inscriptions ou rendez-vous doivent être conservées dans un agenda. Vérifiez régulièrement si un délai a été modifié.'],
      ['Lire avec recul', 'Un titre peut simplifier une information complexe. Lisez les détails, la zone concernée et les conditions avant d’agir.'],
    ],
    official: 'https://www.mapnews.ma/',
  },
];

const NEWS_ARTICLE_MAP = new Map(NEWS_ARTICLES.map(article => [article.slug, article]));

if (typeof module !== 'undefined') module.exports = { NEWS_CATEGORIES, NEWS_ARTICLES, NEWS_ARTICLE_MAP };
