This script processes the course content into a format compatible with the new GDSchool platform.

The main script is located in `src/index.ts`, it:
- Takes the content from a folder called `/content-gdschool` located in the same folder as the script.
- Rewrites the image paths from relative ones (like `images/course-thumbnail.png`) to absolute ones (like `/courses/learn-to-code-with-godot/introduction/images/course-thumbnail.png`)
- Replaces the include shortcodes (like `{{ include FileName.gd anchor_name }}`) with codeblocks taken from files located in Godot projects.
- Saves the processed content into a folder called `/content-gdschool-processed`.
- Compresses the processed content as a zip archive and saves into the folder called `/content-gdschool-releases`.

# Create a new release of the course
To use this script to process a course and create a new release, take the file `workflows/release-course.yml`, and place it into the folder `.github/workflows` inside of the course repo.

To make this workflow work, make sure to go to the course repo `Settings > Actions > General > Workflow permissions` and set it to "Read and Write permissions".

To trigger the workflow for the course, create and push a new tag like so:
```
git tag v1.0.0 && git push --tags
```

# Create a new release of this tool
To create a new release of this tool, create and push a new tag in this repo.

It will create a release with compiled binaries for Linux, Mac, and Windows.