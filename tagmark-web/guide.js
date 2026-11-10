import { h } from './dom.js';

/* Small helpers so the guide reads like prose in the source. */
const k = (t) => h('kbd', {}, t);
const c = (t) => h('code', {}, t);
const P = (...kids) => h('p', {}, kids);
const H3 = (t) => h('h3', {}, t);
const UL = (items) => h('ul', {}, items.map((i) => h('li', {}, i)));
const OL = (items) => h('ol', {}, items.map((i) => h('li', {}, i)));
const NOTE = (...kids) => h('div', { class: 'gnote' }, kids);
const EX = (title, ...lines) =>
  h('div', { class: 'gex' }, h('div', { class: 'gex-title' }, title), lines.map((l) => h('div', { class: 'gex-line' }, l)));
const TABLE = (head, rows) =>
  h('div', { class: 'gtable' },
    h('table', {},
      h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((cell) => h('td', {}, cell)))))));

const SECTIONS = () => [
  {
    id: 'start', title: 'Getting started',
    body: [
      P('Tagmark saves a page in one click and tags it for you. Everything you save lives in the library, which is this page you are looking at.'),
      H3('Save a page'),
      OL([
        'Open any web page.',
        ['Click the Tagmark icon in Chrome’s toolbar. If you can’t see it, click the puzzle icon and pin Tagmark.'],
        'The page is saved at once with its title, image and tags. A small popup shows what it did.',
      ]),
      P('In the popup you can remove a tag with the ×, add your own by typing and pressing ', k('Enter'), ', open the library, or remove the bookmark.'),
      UL([
        'Saving a page you already saved just says “Already in your library”. Tracking bits like utm_ and #sections are ignored when Tagmark checks for duplicates.',
        'Chrome doesn’t let extensions read some pages (chrome:// pages, the Chrome Web Store). Those can’t be saved.',
        'If the icon does nothing on a tab that was open before you installed Tagmark, reload that tab once.',
      ]),
    ],
  },
  {
    id: 'tagging', title: 'How automatic tagging works',
    body: [
      P('Every saved page goes through the same steps, in this order:'),
      OL([
        [h('strong', {}, 'Built-in rules'), ' recognise where the page comes from (X, LinkedIn, YouTube, GitHub, articles) and set its type and tags.'],
        [h('strong', {}, 'Fallback.'), ' If nothing matched, the page becomes a Web Link.'],
        [h('strong', {}, 'Topics'), ' read the title, description, headings and text for keywords and add tags like Design or Coding.'],
        [h('strong', {}, 'Your rules'), ' run last. They can see the type and tags from the steps above, so a rule can say “if it’s an article and…”.'],
        [h('strong', {}, 'Smart folders'), ' look at the finished result and pick up what matches.'],
      ]),
      P('Every bookmark gets one ', h('strong', {}, 'type'), ': Post, Profile, Video, Article, Repo or Web link. Types power the optional entries in the sidebar and the “type” field in rules.'),
      NOTE('Your hand edits win. A tag you add stays, and an automatic tag you remove stays removed, even after rules are re-run. Re-running only refreshes the automatic tags.'),
    ],
  },
  {
    id: 'builtin', title: 'Built-in rules',
    body: [
      P('These ship with Tagmark. You can turn any of them off in Settings, Built-in rules.'),
      TABLE(['When the link is', 'Tags added', 'Type'], [
        ['An X post (x.com/name/status/…)', 'X, X Post', 'Post'],
        ['An X profile (x.com/name)', 'X, Profile', 'Profile'],
        ['A LinkedIn post (/posts/ or /feed/update/)', 'LinkedIn, LinkedIn Post', 'Post'],
        ['A LinkedIn profile (/in/…)', 'LinkedIn, Profile', 'Profile'],
        ['A LinkedIn company page (/company/…)', 'LinkedIn, Profile, Company', 'Profile'],
        ['A LinkedIn article (/pulse/…)', 'LinkedIn, Article', 'Article'],
        ['A YouTube video, short or live stream', 'YouTube, Video', 'Video'],
        ['A YouTube channel', 'YouTube, Profile', 'Profile'],
        ['A GitHub repository (github.com/owner/repo)', 'GitHub, Repo', 'Repo'],
        ['A page that says it is an article, or Medium, Substack, dev.to and similar', 'Article', 'Article'],
        ['Anything else', 'Web Link', 'Web link'],
      ]),
    ],
  },
  {
    id: 'rules', title: 'Your rules',
    body: [
      P('A rule says: ', h('strong', {}, 'when'), ' a page looks like this, ', h('strong', {}, 'add'), ' this tag. Create one in Settings, Your rules, New rule.'),
      H3('The parts of a rule'),
      UL([
        [h('strong', {}, 'Name.'), ' Only for you, so you can recognise it later.'],
        [h('strong', {}, 'All or any.'), ' “All conditions match” needs every condition to be true. “Any condition matches” needs just one.'],
        [h('strong', {}, 'Conditions.'), ' Each one is a field, an operator and a value, such as “handle is Gentlenmasc”. Add as many as you like.'],
        [h('strong', {}, 'Tag to add.'), ' The tag that is added when the conditions match.'],
      ]),
      H3('Fields you can look at'),
      TABLE(['Field', 'What it is'], [
        [c('url'), 'The full address, for example https://x.com/Gentlenmasc/status/123'],
        [c('host'), 'Just the site without www, for example x.com. It also matches subdomains, so figma.com matches www.figma.com.'],
        [c('path'), 'Everything after the site, for example /Gentlenmasc/status/123'],
        [c('handle'), 'The username inside the address, for X, Instagram, GitHub, TikTok, LinkedIn (/in/ and /company/) and YouTube (@name). Empty on other sites.'],
        [c('title'), 'The page title'],
        [c('description'), 'The page’s own short description'],
        [c('type'), 'post, profile, video, article, repo or link, as decided by the built-in rules'],
        [c('tags'), 'The tags the page has so far from built-in rules and topics'],
        [c('keywords'), 'The keyword tags the page declares about itself'],
        [c('text'), 'The first part of the page’s readable text (about 5,000 characters)'],
      ]),
      H3('Operators'),
      TABLE(['Operator', 'Meaning'], [
        ['contains / does not contain', 'The field has (or lacks) this text anywhere in it'],
        ['is / is not', 'The field is exactly this. Capital letters don’t matter.'],
        ['starts with / ends with', 'Matches the beginning or the end'],
        ['is one of', ['A comma-separated list, for example ', c('substack.com, beehiiv.com'), '. Any one of them is enough.']],
        ['matches regex', 'For advanced patterns, for example ' + '^https://github\\.com/[^/]+/[^/]+/issues'],
        ['is empty / is not empty', 'Checks whether the field has anything in it. No value needed.'],
      ]),
      P('Matching ignores capital letters everywhere, including regex.'),
      H3('Examples to copy'),
      EX('Follow a person', ['When ', c('handle'), ' is ', c('Gentlenmasc')], ['Add tag ', c('Gentlenmasc')]),
      EX('All Figma links', ['When ', c('host'), ' is ', c('figma.com')], ['Add tag ', c('Figma')]),
      EX('Newsletters', ['When ', c('host'), ' is one of ', c('substack.com, beehiiv.com, convertkit.com')], ['Add tag ', c('Newsletter')]),
      EX('Case studies', ['Match ', h('strong', {}, 'all'), ': ', c('type'), ' is ', c('article'), ' and ', c('title'), ' contains ', c('case study')], ['Add tag ', c('Case study')]),
      EX('Typography, however it is worded', ['Match ', h('strong', {}, 'any'), ': ', c('title'), ' contains ', c('typography'), ', ', c('title'), ' contains ', c('typeface')], ['Add tag ', c('Type')]),
      H3('Good to know'),
      UL([
        'Rules run in the order they are listed, after the built-in rules and topics.',
        'Saving or changing a rule re-tags everything you have already saved straight away.',
        'A rule only adds a tag. To drop a tag from one bookmark, remove it in the popup.',
        ['If a rule doesn’t fire, check the field first. ', c('host'), ' is the site (x.com), while ', c('url'), ' is the whole address. Then check spelling, and whether “all” should be “any”.'],
      ]),
    ],
  },
  {
    id: 'folders', title: 'Folders',
    body: [
      P('There are two kinds. Create either with the + next to Folders in the sidebar, or in Settings, Folders.'),
      H3('Manual folders'),
      P('A folder with no conditions. Select bookmarks, then use ', h('strong', {}, 'Move to…'), ' in the bar at the bottom. A bookmark sits in one manual folder at a time.'),
      H3('Smart folders'),
      P('A folder with conditions fills itself, and stays up to date as you save more. A bookmark can appear in several smart folders. The conditions work exactly like rule conditions.'),
      EX('Profiles', ['When ', c('type'), ' is ', c('profile')]),
      EX('Design reading', ['Match all: ', c('type'), ' is ', c('article'), ' and ', c('tags'), ' contains ', c('Design')]),
      EX('One person', ['When ', c('url'), ' contains ', c('gentlenmasc')]),
      NOTE('Smart folders can use url, host, path, handle, title, description, type and tags. They can’t look at the page text or keywords. To use those, make a rule that adds a tag, then base the folder on that tag.'),
    ],
  },
  {
    id: 'topics', title: 'Topics',
    body: [
      P('Topics are how Tagmark guesses subjects like Design, Coding and Engineering without any AI. Each topic is a list of words and websites, and each one carries a weight.'),
      H3('How the score works'),
      UL([
        'Every keyword found adds its weight to the topic’s score. A word in the title counts three times, in the description twice, in the page’s keywords twice, in headings one and a half times, and in the page text once. A word counts at most three times per place.',
        'A matching website adds its weight too. Domains use big weights (4 to 6), so a site like dribbble.com settles it on its own.',
        'If the total reaches the topic’s threshold (6 by default), the topic’s tag is added. A bookmark can get up to three topics.',
      ]),
      EX('Example', 'A page titled “Building a design system in Figma” hits “design system” and “figma” in the title. That is well above 6, so it gets the Design tag.'),
      H3('Tuning'),
      UL([
        'A tag appears where it shouldn’t: raise that topic’s threshold, for example from 6 to 8, or lower the weight of the word causing it.',
        'A tag is missing: add words from that page’s title to the topic at weight 2 or 3, or lower the threshold.',
        'Edit a topic in Settings, Topics, Edit. Write one word per line like “figma: 3”. Domains go in their own box like “dribbble.com: 6”.',
        'Switch a topic off with its toggle, or use Reset to defaults to go back to the original lists.',
      ]),
    ],
  },
  {
    id: 'tags', title: 'Tags and the Tags page',
    body: [
      UL([
        ['Open ', h('strong', {}, 'All tags'), ' in the sidebar to see every tag with how many bookmarks it has. Click a tag to see its bookmarks.'],
        ['Hover a tag on that page and a pin appears at the right. ', h('strong', {}, 'Pinned tags'), ' show in the sidebar under Tags, in the order you pinned them. Click the pin again to unpin.'],
        'Tag colours are generated from the tag’s name, so a tag always has the same colour everywhere.',
        'Add tags to one bookmark in the popup, or to many at once with the Add tag box in the selection bar.',
        'Counts only include bookmarks that are not archived or in the Trash.',
      ]),
    ],
  },
  {
    id: 'views', title: 'Views, sorting and search',
    body: [
      UL([
        [h('strong', {}, 'Gallery'), ' shows big thumbnails in a grid where every card is the same size. ', h('strong', {}, 'List'), ' shows one row per bookmark with its date. Switch with the toggle at the top right.'],
        [h('strong', {}, 'Sort'), ' by date created (newest or oldest first) or by name (A to Z or Z to A) with the menu next to the toggle.'],
        ['Press ', k('/'), ' to search. It looks in titles, addresses, descriptions and tags.'],
      ]),
    ],
  },
  {
    id: 'select', title: 'Selecting and bulk actions',
    body: [
      UL([
        'Hover a bookmark and click the round checkbox, or highlight it with the arrow keys and press x.',
        'Once something is selected, clicking any bookmark selects it instead of opening it. Hold Shift to select a range.',
        'A bar appears at the bottom. Add a tag, move to a folder, archive, or move to Trash. The ✕ clears the selection.',
      ]),
    ],
  },
  {
    id: 'archive', title: 'Archive and Trash',
    body: [
      UL([
        [h('strong', {}, 'Archive'), ' hides a bookmark from All bookmarks, tags and folders without deleting it. Find it under Archived. Unarchive it from there.'],
        [h('strong', {}, 'Trash'), ' is where deleted bookmarks wait. Restore them, delete them forever, or use Empty trash. Nothing is removed until you do.'],
        'After archiving or trashing you get an Undo button for a few seconds.',
        'If you save a page that is sitting in the Trash, it comes back.',
      ]),
    ],
  },
  {
    id: 'shortcuts', title: 'Keyboard shortcuts',
    body: [
      P('Press ', k('?'), ' in the library to see this list any time.'),
      TABLE(['Keys', 'What it does'], [
        [k('/'), 'Search (also ⌘K or Ctrl+K)'],
        [[k('←'), ' ', k('→'), ' ', k('↑'), ' ', k('↓')], 'Move between bookmarks (j and k also work)'],
        [k('Enter'), 'Open the highlighted bookmark'],
        [k('x'), 'Select or unselect it'],
        [k('⌘/Ctrl + A'), 'Select everything shown'],
        [k('t'), 'Add a tag to the selection'],
        [k('e'), 'Archive or unarchive'],
        [k('Delete'), 'Move to Trash (or delete forever, when you are in Trash)'],
        [k('r'), 'Restore from Trash'],
        [k('Esc'), 'Clear the selection, close a menu or go back'],
      ]),
    ],
  },
  {
    id: 'settings', title: 'Settings, sidebar and theme',
    body: [
      UL([
        [h('strong', {}, 'Your rules, Folders, Topics, Built-in rules'), ': everything that controls tagging, covered above.'],
        [h('strong', {}, 'Sidebar'), ': choose what shows. Archived, Trash, Folders and Pinned tags are on by default, and you can add Posts, Profiles, Videos, Articles, Repos or Web links. All bookmarks is always on.'],
        [h('strong', {}, 'Appearance'), ': System, Light or Dark. System follows your computer.'],
      ]),
    ],
  },
  {
    id: 'sync', title: 'Sync and the web app',
    body: [
      P('Sync keeps the extension on every computer and the Tagmark website in step. It uses a free Supabase project that belongs to you, so your bookmarks never pass through anyone else’s server.'),
      H3('Set it up once'),
      OL([
        ['Create a free project at ', c('supabase.com'), '.'],
        ['In the project, open ', h('strong', {}, 'SQL Editor'), ', paste the contents of ', c('supabase.sql'), ' and press Run.'],
        ['Optional, for personal use: under ', h('strong', {}, 'Authentication, Providers, Email'), ', turn off “Confirm email” so you can sign in straight away.'],
        ['Open ', h('strong', {}, 'Project settings, API'), '. Copy the Project URL and the ', c('anon public'), ' key into ', c('config.js'), '.'],
        'Reload the extension, then go to Settings, Sync and create your account.',
        'On the website and on other computers, use the same config.js and sign in with the same account.',
      ]),
      NOTE('Only use the anon key. Never paste the service_role key into Tagmark. The anon key is safe to ship because row-level security means each account can only ever read and change its own rows.'),
      H3('What syncs'),
      UL([
        'Bookmarks, including archived ones and the Trash, plus folders, your rules, topics, pinned tags, and your view, sort and sidebar choices.',
        'The theme is per device and doesn’t sync.',
        'If the same bookmark was changed on two devices, the most recent change wins.',
        'Tagmark works offline. Changes wait on the device and sync as soon as it is back online.',
      ]),
      H3('The website'),
      UL([
        'It’s the same library, opened in any browser. Use Add link to save a page. When you are signed in it reads the page’s title and image for you.',
        'Saving a page in one click still needs the extension.',
      ]),
    ],
  },
  {
    id: 'data', title: 'Your data and backups',
    body: [
      UL([
        'Until you turn on sync, everything is stored in this browser on this computer and isn’t sent anywhere. With sync on, a copy also lives in your own Supabase project.',
        'Removing the extension or clearing the browser’s extension data deletes your bookmarks. Use Settings, Data, Export JSON now and then.',
        'Import JSON adds the bookmarks, folders and rules from a backup. It doesn’t overwrite what you have.',
        'Re-run rules on all re-tags everything with your current rules and topics.',
      ]),
    ],
  },
  {
    id: 'help', title: 'When something looks wrong',
    body: [
      H3('The library looks empty'),
      P('Check the search box, then the view you are in. Archived and Trashed bookmarks don’t show under All bookmarks.'),
      H3('A tag is wrong'),
      P('Remove it in the popup or on the bookmark. If it keeps happening for similar pages, raise that topic’s threshold or add a rule.'),
      H3('A rule isn’t doing anything'),
      P('Open the rule and check the field, spelling and all versus any. Try host instead of url for site names.'),
      H3('A thumbnail is missing'),
      P('Some sites don’t offer an image. Tagmark shows a coloured letter instead.'),
      H3('The icon does nothing'),
      P('The page may be one Chrome doesn’t allow, or it was open before you installed Tagmark. Reload the tab and try again.'),
    ],
  },
];

export function renderGuide() {
  const sections = SECTIONS();
  return h('div', { class: 'guide' },
    h('p', { class: 'lead' }, 'How Tagmark saves, tags and organises your links. Skim the contents or read it top to bottom.'),
    h('nav', { class: 'toc', 'aria-label': 'Guide contents' },
      sections.map((s) => h('a', { href: '#/guide/' + s.id }, s.title))),
    sections.map((s) => h('section', { id: 'g-' + s.id }, h('h2', {}, s.title), s.body)));
}
