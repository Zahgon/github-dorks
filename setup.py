from setuptools import setup

with open('README.md', 'r') as f:
    long_description = f.read()

setup(
    name='github-dorks',
    version='0.1.1',
    description='Find leaked secrets via github search.',
    license='Apache License 2.0',
    long_description=long_description,
    author='Samar Dhwoj Acharya (@techgaun)',
    long_description_content_type='text/markdown',
    scripts=['github-dork.py'],
    data_files=[('github-dorks', ['github-dorks.txt'])],
    python_requires='>=3.10',
    install_requires=[
        'github3.py==4.0.1',
        'feedparser>=6.0.12,<7',
    ],
)
