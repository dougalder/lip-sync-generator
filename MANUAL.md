# Deck to Final Cut Pro: user manual

This manual covers every part of the app, from loading a file to importing the result into Final Cut Pro. For a short overview, see the [README](../README.md).

## Contents

1. [How it works](#how-it-works)
2. [Opening the app](#opening-the-app)
3. [Loading a deck or script](#loading-a-deck-or-script)
4. [Markdown reference](#markdown-reference)
5. [The timeline](#the-timeline)
6. [Slide preview and details](#slide-preview-and-details)
7. [Settings tab](#settings-tab)
8. [Text tab](#text-tab)
9. [Images tab](#images-tab)
10. [Notes tab](#notes-tab)
11. [Export tab](#export-tab)
12. [Downloading and importing](#downloading-and-importing)
13. [How the Final Cut Pro project is built](#how-the-final-cut-pro-project-is-built)
14. [What doesn't come across](#what-doesnt-come-across)
15. [Fonts](#fonts)
16. [Troubleshooting](#troubleshooting)
17. [Preferences and privacy](#preferences-and-privacy)

---

## How it works

You write and arrange content in a tool you already know: PowerPoint, Keynote, Google Slides or a Markdown text file. The app reads the structure and the parts worth keeping, such as text, colors, pictures, shapes, notes and sections, and writes a Final Cut Pro project with those parts placed on a timeline.

It's designed as a one-way trip. The app doesn't try to reproduce animations, transitions or slide builds, because that work is better done in Final Cut Pro. Once you start editing in Final Cut Pro, treat that project as the master. If you convert the deck again later, you get a new project rather than an update to the old one.

## Opening the app

There are three ways to run it, and they behave the same:

- **Online:** open the hosted page, such as this repository's GitHub Pages site.
- **From the repository:** download `index.html` and double-click it.
- **As a saved copy:** click **Save this page** at the top of the app. Your browser saves `Deck to Final Cut Pro.html` to your Downloads folder. Open that file any time, even without an Internet connection. In a saved copy the button reads **Save a copy**, so you can make more copies to share.

The page layout, from top to bottom:

- **Header:** a short description, tips for getting your files, and the **Private and offline** note. Every text field has a **×** button to clear it; Edit › Undo brings the text back.
- **Top-right corner:** the **Dark mode** / **Light mode** toggle.
- **Download .zip:** once a file is loaded, a card with the file name and the **Download .zip** button appears under the description.
- **Left column:** the file area and the timeline.
- **Right column:** the settings tabs, and below them the selected slide's **Preview** and **Details**.

On a narrow window, such as an iPad in portrait or a phone, the columns stack.

## Loading a deck or script

Drop a file anywhere on the page, or click **Choose file**. The app accepts:

| File | What it is |
|---|---|
| `.pptx` | A PowerPoint presentation, including exports from Keynote and Google Slides |
| `.md`, `.markdown`, `.txt` | A Markdown script |

The app works out which kind of file it has from the file itself, so a Markdown file with an unusual extension still loads correctly.

Once a file is loaded, the file area shows its name and a summary such as "16 slides, 86 images" or "Markdown, 6 beats". **Choose another file** replaces it.

### Getting a .pptx from other apps

- **Keynote:** File › Export To › PowerPoint.
- **Google Slides:** File › Download › Microsoft PowerPoint (.pptx).
- **PowerPoint:** if the deck is in an older `.ppt` format, save it again as `.pptx`.

### Getting Markdown from Apple Notes

On the latest macOS, choose **File › Export as › Markdown** in Notes. Any text editor works too; save the file with a `.md` extension.

### Typing Markdown in the page

Turn on **Type Markdown here instead** below the file area to open an editor. The empty editor shows an annotated sample of the syntax in grey; it disappears when you click into the field. Two buttons sit under the editor:

- **Load example** fills the editor with a short working script.
- **Add images** lets you pick picture files your script refers to.

When a `.md` file is loaded, the same switch reads **Edit the Markdown here** and lets you change that file's text in the page. The original file on your disk isn't changed.

### Adding images to a Markdown script

A Markdown file only names its images; it doesn't contain them. Click **Add images** (or drop picture files on the page) and select them. Supported formats are PNG, JPEG, GIF, WebP and BMP. The app matches pictures by file name, ignoring any folder path and letter case, so `![](photos/Loaf.JPG)` matches a file called `loaf.jpg`. Added pictures appear as small chips you can remove with **×**. Any image the script names that you haven't added gets a red to-do marker.

## Markdown reference

A Markdown script is a list of **beats**. Each beat becomes one segment on the timeline, like a slide.

### Splitting beats

- A `#` or `##` heading starts a new beat.
- Or put a line of three dashes (`---`) between beats. If a script uses `---` lines anywhere outside the settings block, the app splits beats **only** at those lines, and headings stay inside their beat.

### Syntax

| You write | What happens |
|---|---|
| `# Heading` | Starts a beat, shows the heading as its title, and adds a chapter marker |
| `## Heading` | Starts a beat and shows the heading as its title |
| `### Heading` to `###### Heading` | A bold subheading line inside the beat |
| Plain text | A line of on-screen text. Consecutive lines join into one paragraph; a blank line starts a new one |
| `- item`, `* item` or `+ item` | A bullet. Indent by two spaces for a sub-bullet |
| `1. item` | A numbered item |
| `**bold**`, `*italic*`, `` `code` ``, `[link](url)` | The marks are removed and the words are kept |
| `> quote` | Shown as plain text |
| Text between ```` ``` ```` fences | Each line is kept exactly as written |
| `<!-- note -->` | A speaker note. Can span several lines |
| `^ note` | A one-line speaker note |
| `![](picture.jpg)` | Places a picture you've added |
| `![bg](picture.jpg)` | Uses a picture as the beat's background |
| `<!-- backgroundColor: #224466 -->` | Sets this beat's background color |
| `<!-- color: #FFEECC -->` | Sets this beat's text color |

Other one-line Marp directives in comments, such as `<!-- paginate: true -->`, are ignored rather than turned into notes, so decks written for Marp load cleanly.

### Settings block

An optional block at the very top of the file, between two `---` lines, sets defaults for the whole script:

```markdown
---
title: How sourdough rises
background: "#1F2A2E"
text: "#F3EDE2"
font: Avenir Next
bodyFont: Georgia
---
```

| Key | Meaning | Default |
|---|---|---|
| `title` | Project name in Final Cut Pro | The file name, or "Markdown project" for text typed in the page |
| `background` (or `backgroundColor`) | Background color for every beat | `#1D2327` (near-black) |
| `text` (or `color`) | Text color | `#F4F1EC` (warm white) |
| `font` | Font for headings, and for body text if `bodyFont` isn't set | Helvetica Neue |
| `bodyFont` | Font for body text | Same as `font` |

[`examples/sourdough.md`](../examples/sourdough.md) uses most of these features.

## The timeline

The timeline panel shows the project Final Cut Pro will open.

- **Segments:** the bottom row is the primary storyline, one segment per slide or beat, labeled `S01`, `S02` and so on with the slide title. A small square shows the background color.
- **Lanes:** rows above the storyline are connected clips. Image and shape layers (blue) sit lowest, with titles (purple) above them, in the same stacking order as on the slide. A dashed clip is the disabled script lane, if you turn it on.
- **Markers:** blue diamonds are speaker notes, red diamonds are to-do markers, and orange triangles on the ruler are chapter markers. Hover over any of them to read it.
- **Summary line:** shows the segment count, total length, number of titles and layers, and the frame size and rate.
- **Zoom:** stretches or compresses the timeline.
- **Selecting:** click any clip or segment to select that slide. Its preview and details appear on the right.
- **Changing one slide's length:** drag the right edge of its segment, which snaps to half seconds, or type a length on the **Details** tab. Segments with a custom length show an orange dot. **Reset lengths** in the summary line, or **Reset timing** on the Settings tab, clears all custom lengths.

## Slide preview and details

When you select a slide, a panel appears under the settings with two tabs.

- **Preview** (the default) draws the slide as Final Cut Pro will show it: background, pictures, shapes and titles, with fonts and colors after any replacements. It updates as you change settings. It's an approximation drawn by the browser; fonts you don't have installed show as a stand-in, and line spacing can differ slightly from Final Cut Pro.
- **Details** lists the background, the slide's length (editable, with **Use default** to clear a custom length), every title with its font and size, every image and shape layer, the speaker notes, and any to-do markers.

## Settings tab

### Frame

| Setting | Options | Notes |
|---|---|---|
| **Size** | 1920 × 1080, 3840 × 2160 (4K), 1280 × 720, 1080 × 1920 vertical, 1080 × 1080 square | The Final Cut Pro project's frame size |
| **Frame rate** | 23.976, 24, 25, 29.97, 30, 50, 59.94, 60 | Defaults to 29.97 |
| **Slides that don't match the frame** | Fit, Fill | For decks whose shape differs from the frame, such as a 4:3 deck in a 16:9 project. **Fit** shows the whole slide with bars at the sides; **Fill** fills the frame and crops the edges. PowerPoint only |

### Timing

| Setting | What it does |
|---|---|
| **Fixed** | Every slide gets the same length |
| **From notes** | Each slide lasts as long as reading its speaker notes aloud takes, plus a second. Slides with short or no notes get the minimum length |
| **Deck timings** | Uses the auto-advance or rehearsed timings saved in the PowerPoint file. Slides without a timing use the length below. PowerPoint only |
| **Seconds per slide** | The length for Fixed. Labeled **Minimum seconds** in From notes, and **Seconds when a slide has no timing** in Deck timings |
| **Speaking rate** | Words per minute for From notes. Defaults to 150 |
| **Custom slide lengths / Reset timing** | Shows how many slides have their own length from the timeline. **Reset timing** clears them all, so every slide follows the timing above again |

## Text tab

| Setting | What it does |
|---|---|
| **Placement** | **As on slide** keeps each text box's position, width and anchoring. **Simple** puts the title near the top and the body text below it, centered, ignoring slide positions (shapes are left out in this mode, since they would no longer line up). Markdown always uses Simple |
| **Text size** | Scales every title by a percentage. 100% matches the slide |
| **Smallest text** | Raises any text smaller than this size, in Final Cut Pro's units on a 1080-line frame, up to it. Defaults to 32, which reads comfortably on video. Set 0 to keep slide sizes exactly |
| **Text from master slides** | Brings in text typed directly onto the slide master or layouts, such as taglines, copyright lines and slide numbers, on every slide that shows it. Slide-number fields show each slide's real number. Only applies with As on slide placement. PowerPoint only |
| **One title per bullet** | Gives every paragraph or bullet its own title clip, with paragraph spacing between them. Makes it easy to animate lines in one at a time |
| **Keep bullet characters** | Adds •, – or · in front of bullets (by indent level) and numbers in front of numbered items |
| **Fonts in this deck** | Lists every font the deck uses. See [Fonts](#fonts) |
| **Fonts that aren't on every Mac become** | The font that replaces any deck font that doesn't ship with macOS, unless you've marked it installed or typed a replacement. Defaults to Helvetica Neue. Choose **Keep them** to turn replacement off |
| **Keep bold from slides** | Off by default. Final Cut Pro shows a font it can't find in the requested style as tiny Helvetica, so bold is only safe if every font has a bold style installed |
| **Heading font** / **Body font** | Overrides every heading or body font at once. Choose from the deck's fonts, fonts on every Mac, or **Other font…** to type any installed font's name |

Text is always centered within its box. Lines are wrapped to the width of the original text box, measured in the actual font where the browser has it.

## Images tab

| Setting | What it does |
|---|---|
| **Images: Positioned** | Each picture is placed on a transparent, full-frame PNG at its position and size on the slide. It drops into place in Final Cut Pro with no adjustment |
| **Images: Original file** | Each picture is exported at its original resolution and centered in the frame. Better if you plan to reposition and animate it yourself |
| **Combine graphics on busy slides** | A slide that would need more than six image and shape layers gets one combined layer instead, keeping the timeline readable. Turn off to keep every layer separate |
| **Backgrounds: Per slide** | Each slide's own background color or picture |
| **Backgrounds: Theme color** | One background color, from the deck's theme or the Markdown settings block, for every slide |
| **Backgrounds: None** | No background clips. Segments become gaps, so you can supply your own footage |

Filled shapes and lines (rectangles, rounded rectangles, ovals, triangles, diamonds, parallelograms, trapezoids, hexagons, pentagons, chevrons, arrows and connectors) are drawn with their fills, gradients, transparency, outlines, rotation and flips. Shapes that sit next to each other in the slide's stacking order share one layer; pictures keep their own layers, so a picture placed over a colored box stays on top of it. Shapes and pictures from the slide master and layouts are included, unless a slide has **Hide background graphics** turned on in PowerPoint.

## Notes tab

| Setting | What it does |
|---|---|
| **Speaker notes: Markers** | Each slide's notes become a marker at the start of its segment. Read them in Final Cut Pro's Timeline Index or by double-clicking the marker |
| **Speaker notes: Script lane** | Notes become a title clip on the top lane, switched off so it never renders. You can read the script on the timeline while you edit, then delete the lane when you're done |
| **Speaker notes: Leave out** | Notes aren't exported |
| **Sections as chapter markers** | PowerPoint sections, and `#` headings in Markdown, become chapter markers. These carry through to exported video files as chapters |
| **Skip hidden slides** | Leaves out slides marked hidden in PowerPoint. PowerPoint only |

## Export tab

The top of the tab, **Importing into Final Cut Pro**, repeats the import steps and lists any warnings, such as items that couldn't be converted or fonts that may be missing. When there are warnings, a red dot appears on the Export tab.

| Setting | What it does |
|---|---|
| **Project name** | The event and project name in Final Cut Pro. Defaults to the file name, or the Markdown `title` |
| **Media links: Relative** | The project finds its media in the `Media` folder next to it, wherever you unzip. Recommended |
| **Media links: Fixed folder** | The project points to one fixed location on your Mac. Fill in **Unzip location**, or enter your **Mac username** and click **Use Downloads** to point at your Downloads folder. Only needed in unusual setups |
| **FCPXML version** | 1.10 (default) needs Final Cut Pro 10.6 or later. Choose 1.9 for Final Cut Pro 10.5, or 1.11 for newer releases if you prefer |

## Downloading and importing

1. Click **Download .zip** under the description at the top of the page. The card shows the file name before you click, and the progress while media is being rendered.
2. Unzip the download anywhere.
3. In Final Cut Pro, choose **File › Import › XML** and select the `.fcpxml` file in the unzipped folder.
4. Final Cut Pro creates a new event containing the project. Open the project from the event.

Exports are named with the date, time, project name and source type, for example:

```
2026-09-24 1432, Quarterly review PPT.zip
└── 2026-09-24 1432, Quarterly review PPT/
    ├── 2026-09-24 1432, Quarterly review PPT.fcpxml
    ├── Media/
    │   ├── Background 1F2A2E.png
    │   ├── S03 image2.png
    │   └── …
    └── Read me.txt
```

The time is your Mac's local time without a colon, because macOS doesn't allow colons in file names. `PPT` or `MD` shows which kind of file the project came from.

Keep the `Media` folder next to the `.fcpxml` file. If you move one without the other, Final Cut Pro will ask you to relink the media (File › Relink Files).

## How the Final Cut Pro project is built

Knowing the structure makes it quicker to work with in Final Cut Pro.

- **Primary storyline:** one clip per slide. It's the background, a full-frame PNG of the slide's color or background picture, or a gap if backgrounds are off. Its name is the segment label, such as `S03 Feeding it`.
- **Connected clips:** everything else is attached to its segment's background clip, so moving or trimming a segment carries its titles and images along.
  - Image and shape layers are full-frame transparent PNGs (or original pictures, if you chose that), named like `S03 image2` or `S06 7 shapes`.
  - Titles are Final Cut Pro's built-in **Basic Title**, so the text stays editable. Each title is named with its segment label and the first words of its text.
- **Markers:** notes markers and to-do markers (to-do markers are unfinished, so they appear in the Timeline Index's to-do list) sit at the start of each segment. Chapter markers mark sections.
- **Durations:** every clip in a segment matches that segment's length. Extend a segment in Final Cut Pro by trimming its background clip, then trim the connected clips to match.

Because titles are separate clips with real text, you can restyle them, apply any title template's look, add motion with keyframes, or replace them with your own templates.

## What doesn't come across

Several items of the same kind on one slide share one marker, for example "Rebuild 21 custom shapes from slide 2".

| Item | What happens |
|---|---|
| Animations, slide builds and transitions | Not exported, by design. Add them in Final Cut Pro |
| Charts, tables, SmartArt, equations and embedded objects | Skipped, with a red to-do marker such as "Rebuild chart from slide 3" |
| EMF, WMF and SVG pictures | Skipped with a to-do marker and a warning. Save them as PNG in the deck to include them |
| Freeform and custom-drawn shapes | Skipped with a to-do marker |
| Picture and pattern fills inside shapes | Not drawn |
| Gradient slide backgrounds | Use the gradient's first color |
| Embedded video and audio | Not carried over. A video may appear as its still poster frame |
| Rotated or vertical text | Comes in horizontal |
| Text alignment | Always centered within the original text box |
| Mixed formatting within a paragraph | The paragraph takes the formatting of its first run of text |
| Bold and italic | Bold only with **Keep bold from slides** on; italic isn't applied |
| Line and paragraph spacing | Approximated. A single title can't add extra space between paragraphs, so use **One title per bullet** for that |
| Hyperlinks and click actions | The text is kept; the link isn't |

## Fonts

Final Cut Pro needs every font in a project to be installed on the Mac doing the import. If a font is missing, Final Cut Pro substitutes Helvetica at size 6, which makes the text almost invisible. The **Fonts in this deck** list on the Text tab helps you avoid that:

- Each font shows how many titles use it, and whether it's **On every Mac** or **Not on every Mac**.
- Fonts that aren't on every Mac are replaced by the font chosen in **Fonts that aren't on every Mac become** (Helvetica Neue by default). The replacement field shows "Uses Helvetica Neue" when that will happen.
- If you have a font installed, tick **I've installed it** to keep it. The app remembers this for future decks.
- Type a name in a font's replacement field to use a specific substitute for that font only.
- Fonts that look like they come from Google Fonts get a **Find on Google Fonts** link, so you can download and install them.
- Microsoft Office fonts such as Calibri, Cambria, Aptos and the "cloud fonts" PowerPoint downloads on demand are labeled **Office font, not usable in Final Cut Pro**. They only work inside Office apps, so choose a replacement.

If text still comes in tiny, see [Troubleshooting](#troubleshooting).

## Troubleshooting

**Text is tiny in Final Cut Pro, and the inspector shows Helvetica at size 6.**
Final Cut Pro couldn't find the font or style. Check the Fonts in this deck list: either install the font, or let it be replaced. Make sure **Keep bold from slides** is off unless every font has a bold style installed.

**Some text is readable but still smaller than you'd like.**
The deck uses small print. Raise **Smallest text**, or raise **Text size** to scale everything.

**Final Cut Pro asks to relink media.**
The `Media` folder isn't next to the `.fcpxml` file, or **Media links** is set to Fixed folder and the folder isn't where the project expects it. Put the unzipped folder back together, or switch to Relative and export again.

**Text runs off the slide or columns overlap.**
Text is wrapped using fonts the browser can see. If a font isn't installed, the wrapping is estimated with a similar font and may differ slightly. Installing the deck's fonts, or choosing a replacement, gives the most accurate result.

**The timeline is very tall.**
A slide has many separate pictures or shapes. Turn on **Combine graphics on busy slides** on the Images tab.

**A picture or shape is missing.**
Check the slide's Details tab for a to-do marker. Vector formats (EMF, WMF, SVG) and freeform shapes are skipped; see [What doesn't come across](#what-doesnt-come-across).

**"This file has no slides part" or "Couldn't read" when loading a deck.**
The file isn't a standard `.pptx`, or it's password-protected. Open it in PowerPoint or Keynote and save or export it again as `.pptx`.

**The Download button asks for permission, or nothing downloads.**
If you use the app inside the Claude app, saving shows a confirmation first. In Safari, check the Downloads list in the toolbar. If downloads are blocked for the page, open the saved HTML copy instead.

**Settings changed unexpectedly.**
Some options only apply to PowerPoint and are dimmed for Markdown: Fit or Fill, Deck timings, Placement, Text from master slides and Skip hidden slides.

## Preferences and privacy

The app remembers some choices in your browser's local storage, on your computer only:

- light or dark mode, and the last settings tab you used
- Text size and Smallest text
- font replacements, fonts marked as installed, and the fallback font
- Media links, Unzip location and Mac username

Preferences are kept per browser, and the online page and a saved copy may keep separate sets. To clear them, clear the website data for the page in your browser's settings.

Nothing else is stored, and nothing is sent anywhere. Decks and scripts are read, converted and zipped entirely inside the browser tab. The only network request the page makes is for its interface font from Google Fonts, which doesn't include any of your content; offline, the system font is used instead.
